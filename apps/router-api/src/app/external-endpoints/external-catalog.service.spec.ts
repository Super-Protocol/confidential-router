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
