import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDataSource, seedCatalog, seedExternalEndpoint } from '../../../test/seed.js';
import { ExternalEndpoint } from '../db/entities/external-endpoint.entity.js';
import { Model } from '../db/entities/model.entity.js';
import { ExternalCatalogService } from './external-catalog.service.js';

let dataSource: DataSource;
let catalog: ExternalCatalogService;

beforeEach(async () => {
  dataSource = await createTestDataSource();
  catalog = new ExternalCatalogService(dataSource);
});

afterEach(async () => {
  await dataSource.destroy();
});

async function setStatus(id: string, status: 'pending' | 'verified' | 'denied' | 'disabled'): Promise<void> {
  await dataSource.getRepository(ExternalEndpoint).update({ id }, { status, updatedAt: new Date() });
}

describe('refresh', () => {
  it('is empty before any verdict, which is where every row starts', async () => {
    await seedExternalEndpoint(dataSource, { status: 'pending' });

    await expect(catalog.refresh()).resolves.toBe(0);
    expect(catalog.list()).toEqual([]);
  });

  it('lists a model once its endpoint is verified', async () => {
    const endpoint = await seedExternalEndpoint(dataSource, { status: 'verified' });

    await expect(catalog.refresh()).resolves.toBe(1);
    expect(catalog.find(endpoint.modelId)).toMatchObject({
      id: endpoint.modelId,
      upstreamModel: 'llama-3.3-70b-instruct',
      endpoint: { name: endpoint.name, listenPort: endpoint.listenPort },
    });
  });

  it('drops a model whose endpoint is denied', async () => {
    // Membership is the fail-closed drop of decision 5, and it is a property of
    // the map rather than a check at the call site.
    const endpoint = await seedExternalEndpoint(dataSource, { status: 'verified' });
    await catalog.refresh();

    await setStatus(endpoint.id, 'denied');
    await expect(catalog.refresh()).resolves.toBe(0);

    expect(catalog.find(endpoint.modelId)).toBeUndefined();
  });

  it('drops a model whose endpoint the operator disabled, even if a verdict stands', async () => {
    const endpoint = await seedExternalEndpoint(dataSource, { status: 'verified' });
    await dataSource.getRepository(ExternalEndpoint).update({ id: endpoint.id }, { enabled: false });

    await expect(catalog.refresh()).resolves.toBe(0);
  });

  it('drops a model the admin disabled while its endpoint stays verified', async () => {
    const endpoint = await seedExternalEndpoint(dataSource, { status: 'verified' });
    await dataSource.getRepository(Model).update({ id: endpoint.modelId }, { enabled: false });

    await expect(catalog.refresh()).resolves.toBe(0);
  });

  it('carries the prices and capabilities the admin registered', async () => {
    // External models feed the ledger and the public model table like any other,
    // which is decision 4; the catalogue is where the gateway reads them from.
    const endpoint = await seedExternalEndpoint(dataSource, { status: 'verified' });
    await catalog.refresh();

    expect(catalog.find(endpoint.modelId)).toMatchObject({
      promptPer1mMicros: 400_000,
      completionPer1mMicros: 800_000,
      capabilities: ['chat', 'completions'],
      tee: 'snp',
    });
  });

  it('surfaces the measurement and digest the verdict observed', async () => {
    const endpoint = await seedExternalEndpoint(dataSource, { status: 'verified' });
    await dataSource
      .getRepository(ExternalEndpoint)
      .update({ id: endpoint.id }, { measurementSeen: 'a'.repeat(64), evidenceDigestSeen: 'sha256/abc' });

    await catalog.refresh();

    expect(catalog.find(endpoint.modelId)?.endpoint).toMatchObject({
      measurementSeen: 'a'.repeat(64),
      evidenceDigestSeen: 'sha256/abc',
    });
  });

  it('never picks up a config model, however the two share a table', async () => {
    // `CatalogService` owns config rows and says why it may resolve them once at
    // boot. This map exists so that assumption stays narrowly true, not so that
    // two services answer for the same row.
    const config = await seedCatalog(dataSource);
    const external = await seedExternalEndpoint(dataSource, { status: 'verified' });

    await catalog.refresh();

    expect(catalog.list().map((model) => model.id)).toEqual([external.modelId]);
    expect(catalog.find(config.modelId)).toBeUndefined();
  });

  it('restricts the list to a key’s model scope', async () => {
    const first = await seedExternalEndpoint(dataSource, { status: 'verified' });
    await seedExternalEndpoint(dataSource, { status: 'verified' });
    await catalog.refresh();

    expect(catalog.list([first.modelId]).map((model) => model.id)).toEqual([first.modelId]);
    expect(catalog.list([])).toEqual([]);
  });

  it('carries the sealed key and the upstream hostname the egress leg needs', async () => {
    // Both are read per request by `ExternalUpstreamClient`: the envelope is
    // opened to inject `Authorization`, and the hostname is what `usage.endpoint`
    // and the response header name — never the loopback port the request went to.
    const endpoint = await seedExternalEndpoint(dataSource, { status: 'verified' });

    await catalog.refresh();

    expect(catalog.find(endpoint.modelId)?.endpoint).toMatchObject({
      hostname: `${endpoint.name}.example`,
      apiKeyCiphertext: 'v1.placeholder',
    });
  });

  it('replaces the map rather than merging into it', async () => {
    // A full rebuild, for the reason the gatekeeper's own snapshots are full: a
    // reader that missed an update must not be able to drift.
    const endpoint = await seedExternalEndpoint(dataSource, { status: 'verified' });
    await catalog.refresh();

    await dataSource.getRepository(Model).delete({ id: endpoint.modelId });
    await catalog.refresh();

    expect(catalog.list()).toEqual([]);
  });
});

describe('findUnadmitted', () => {
  /**
   * The third answer a lookup needs, and the reason it exists: admission has to
   * tell "no such model" apart from "this model exists and I will not proxy to
   * it". A model that merely vanished from the catalogue would make every
   * fail-closed refusal read to the caller as a typo in `model`.
   */
  it('reports a registered model whose endpoint has no verdict yet', async () => {
    const endpoint = await seedExternalEndpoint(dataSource, { status: 'pending' });

    await catalog.refresh();

    expect(catalog.find(endpoint.modelId)).toBeUndefined();
    expect(catalog.findUnadmitted(endpoint.modelId)).toEqual({
      id: endpoint.modelId,
      endpointName: endpoint.name,
      status: 'pending',
      stage: null,
      reason: null,
    });
  });

  it('carries the stage and reason of a denial, so the refusal can name it', async () => {
    const endpoint = await seedExternalEndpoint(dataSource, { status: 'verified' });
    await dataSource
      .getRepository(ExternalEndpoint)
      .update(
        { id: endpoint.id },
        { status: 'denied', lastStage: 'policy', lastReason: 'measurement is not on the trust list' },
      );

    await catalog.refresh();

    expect(catalog.findUnadmitted(endpoint.modelId)).toMatchObject({
      status: 'denied',
      stage: 'policy',
      reason: 'measurement is not on the trust list',
    });
  });

  it('says nothing about a model on a disabled endpoint — that is not a failed attestation', async () => {
    // `disabled` is the operator's own switch (the one value the status poll never
    // writes). Reporting it as an attestation failure would blame an upstream for
    // an admin's decision; the model is simply out of the catalogue, like a
    // retired one.
    const endpoint = await seedExternalEndpoint(dataSource, { status: 'verified' });
    await dataSource.getRepository(ExternalEndpoint).update({ id: endpoint.id }, { enabled: false });

    await catalog.refresh();

    expect(catalog.find(endpoint.modelId)).toBeUndefined();
    expect(catalog.findUnadmitted(endpoint.modelId)).toBeUndefined();
  });

  it('forgets a model as soon as a verdict admits it', async () => {
    const endpoint = await seedExternalEndpoint(dataSource, { status: 'pending' });
    await catalog.refresh();
    expect(catalog.findUnadmitted(endpoint.modelId)).toBeDefined();

    await setStatus(endpoint.id, 'verified');
    await catalog.refresh();

    expect(catalog.findUnadmitted(endpoint.modelId)).toBeUndefined();
    expect(catalog.find(endpoint.modelId)).toBeDefined();
  });

  it('knows nothing about a model that was never registered', async () => {
    await catalog.refresh();

    expect(catalog.findUnadmitted('someone/else:snp')).toBeUndefined();
  });
});

/**
 * The third projection: what the Models page and the chat picker read.
 *
 * Its one behavioural difference from `list()` is the whole reason it exists —
 * a denied upstream's models stay in it, with `available: false`. The external
 * vocabulary has to have something to say *denied by this router* about, and a
 * catalogue that dropped the row would make an operator's switch and a failed
 * attestation look identical from the outside (ADR-008 §1).
 */
describe('listCatalogue', () => {
  it('is empty before anything is registered', async () => {
    await catalog.refresh();

    expect(catalog.listCatalogue()).toEqual([]);
  });

  it('lists a verified endpoint’s model as available', async () => {
    const endpoint = await seedExternalEndpoint(dataSource, { status: 'verified' });

    await catalog.refresh();

    expect(catalog.listCatalogue()).toMatchObject([
      { id: endpoint.modelId, available: true, upstream: { name: endpoint.name, status: 'verified' } },
    ]);
  });

  it('keeps a pending endpoint’s model, unavailable, so the catalogue can say so', async () => {
    const endpoint = await seedExternalEndpoint(dataSource, { status: 'pending' });

    await catalog.refresh();

    expect(catalog.list()).toEqual([]);
    expect(catalog.listCatalogue()).toMatchObject([
      { id: endpoint.modelId, available: false, upstream: { status: 'pending' } },
    ]);
  });

  it('keeps a denied endpoint’s model, unavailable', async () => {
    const endpoint = await seedExternalEndpoint(dataSource, { status: 'verified' });
    await catalog.refresh();

    await setStatus(endpoint.id, 'denied');
    await catalog.refresh();

    expect(catalog.listCatalogue()).toMatchObject([
      { id: endpoint.modelId, available: false, upstream: { status: 'denied' } },
    ]);
  });

  it('drops a model whose endpoint the operator disabled — a switch, not a verdict', async () => {
    const endpoint = await seedExternalEndpoint(dataSource, { status: 'verified' });
    await dataSource.getRepository(ExternalEndpoint).update({ id: endpoint.id }, { enabled: false });

    await catalog.refresh();

    // Taken out of service, so it is absent from the price list entirely rather
    // than listed as something this router refuses.
    expect(catalog.listCatalogue()).toEqual([]);
  });

  it('carries the prices, context and capabilities a catalogue row needs', async () => {
    const endpoint = await seedExternalEndpoint(dataSource, { status: 'verified' });

    await catalog.refresh();

    expect(catalog.listCatalogue()[0]).toMatchObject({
      id: endpoint.modelId,
      contextLength: 131_072,
      capabilities: ['chat', 'completions'],
      promptPer1mMicros: 400_000,
      completionPer1mMicros: 800_000,
    });
  });

  it('carries the upstream’s hostname and what the last verdict saw, and no credential', async () => {
    const endpoint = await seedExternalEndpoint(dataSource, { status: 'verified' });
    await dataSource
      .getRepository(ExternalEndpoint)
      .update({ id: endpoint.id }, { measurementSeen: 'b'.repeat(64), evidenceDigestSeen: 'sha256/upstream' });

    await catalog.refresh();

    const [entry] = catalog.listCatalogue();
    expect(entry?.upstream).toMatchObject({
      hostname: `${endpoint.name}.example`,
      measurementSeen: 'b'.repeat(64),
      evidenceDigestSeen: 'sha256/upstream',
    });
    // Smaller than `ExternalCatalogEndpoint` on purpose: the catalogue has no
    // use for a base URL, a listen port or a sealed key, and the surfaces it
    // feeds are readable without a session.
    expect(JSON.stringify(entry)).not.toContain('v1.placeholder');
    expect(entry?.upstream).not.toHaveProperty('baseUrl');
    expect(entry?.upstream).not.toHaveProperty('listenPort');
  });

  it('replaces the list rather than merging into it', async () => {
    await seedExternalEndpoint(dataSource, { status: 'verified' });
    await catalog.refresh();
    await dataSource.getRepository(Model).delete({ origin: 'external' });

    await catalog.refresh();

    expect(catalog.listCatalogue()).toEqual([]);
  });
});
