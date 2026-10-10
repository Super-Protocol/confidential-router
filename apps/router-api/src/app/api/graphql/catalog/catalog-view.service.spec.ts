import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { CatalogModel, CatalogService } from '../../../catalog/catalog.service.js';
import type { Endpoint } from '../../../db/entities/endpoint.entity.js';
import type { EvidenceSnapshot } from '../../../db/entities/evidence-snapshot.entity.js';
import type { EvidenceCoverageStatsService, EvidenceService } from '../../../evidence/index.js';
import type { ExternalCatalogService, ExternalCatalogueEntry } from '../../../external-endpoints/index.js';
import { CatalogViewService } from './catalog-view.service.js';
import { ModelOriginEnum } from './model.model.js';

/*
 * The enum constants rather than their SDL spellings: the resolver returns the
 * value the `models` table holds, and GraphQL maps it to `CONFIG` / `EXTERNAL`
 * on the way out. Asserting on the names here would be asserting on a layer this
 * file does not run.
 */

/**
 * How the two kinds of model share one `models` list without sharing a word of
 * each other's vocabulary (ADR-008 §1).
 *
 * The services under it are stubs rather than a database: what is being checked
 * is the projection — which fields are populated for which origin, what an
 * anonymous caller is handed, and what the TEE filter does to a model that has no
 * TEE label. Where the rows come from is `external-catalog.service.spec.ts`'s
 * subject, and it runs against a migrated database.
 */

const OWN_ENDPOINT = {
  id: 'ep-1',
  name: 'demo-tee',
  hostname: 'router.example.test',
  tee: 'Intel TDX + H100 CC',
  declaredImages: null,
  enabled: true,
  updatedAt: new Date('2026-10-01T00:00:00.000Z'),
} as Endpoint;

function configModel(overrides: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id: 'meta/llama-3.3-70b-instruct:tdx',
    name: 'Llama 3.3 70B Instruct',
    litellmModel: 'vllm/llama',
    contextLength: 131_072,
    capabilities: ['chat'],
    promptPer1mMicros: 280_000,
    completionPer1mMicros: 420_000,
    endpoint: {
      id: OWN_ENDPOINT.id,
      name: OWN_ENDPOINT.name,
      hostname: OWN_ENDPOINT.hostname,
      tee: OWN_ENDPOINT.tee,
      declaredImages: null,
    },
    updatedAt: new Date('2026-10-01T00:00:00.000Z'),
    ...overrides,
  } as CatalogModel;
}

function externalEntry(overrides: Partial<ExternalCatalogueEntry> = {}): ExternalCatalogueEntry {
  return {
    id: 'partner/llama-3.3-70b:snp',
    name: 'Llama 3.3 70B (partner)',
    contextLength: 131_072,
    capabilities: ['chat'],
    promptPer1mMicros: 400_000,
    completionPer1mMicros: 800_000,
    available: true,
    upstream: {
      id: 'ext-1',
      name: 'partner-cloud',
      hostname: 'partner.example.test',
      status: 'verified',
      lastCheckedAt: new Date('2026-10-06T12:00:00.000Z'),
      measurementSeen: 'a'.repeat(64),
      evidenceDigestSeen: 'sha256/upstream',
      evidenceDigestSeenHex: null,
    },
    ...overrides,
  };
}

function build(
  options: {
    config?: CatalogModel[];
    external?: ExternalCatalogueEntry[];
    own?: Endpoint | null;
    latest?: EvidenceSnapshot[];
  } = {},
): CatalogViewService {
  return new CatalogViewService(
    { list: () => options.config ?? [configModel()] } as unknown as CatalogService,
    { listCatalogue: () => options.external ?? [externalEntry()] } as unknown as ExternalCatalogService,
    {
      activeEndpoints: vi.fn().mockResolvedValue([OWN_ENDPOINT]),
      latestForMany: vi
        .fn()
        .mockResolvedValue(new Map((options.latest ?? []).map((snapshot) => [snapshot.endpointId, snapshot]))),
      stateOfSnapshot: (snapshot: EvidenceSnapshot | null) => (snapshot ? 'PUBLISHED' : 'NOT_PUBLISHED'),
      ownEndpoint: vi.fn().mockResolvedValue(options.own === undefined ? OWN_ENDPOINT : options.own),
    } as unknown as EvidenceService,
    { tokensByEndpoint: vi.fn().mockResolvedValue(new Map()) } as unknown as EvidenceCoverageStatsService,
  );
}

/** A stored publication of {@link OWN_ENDPOINT} whose chain ends in `rootPem`. */
function snapshotWithRoot(rootPem: string): EvidenceSnapshot {
  return {
    id: 'snap-1',
    endpointId: OWN_ENDPOINT.id,
    externalEndpointId: null,
    fetchedAt: new Date('2026-10-09T22:00:00.000Z'),
    issuedAt: new Date('2026-10-09T21:59:00.000Z'),
    evidenceDigest: `sha256/${'A'.repeat(43)}`,
    evidenceDigestHex: '0'.repeat(64),
    certFingerprint: `sha256/${'B'.repeat(43)}`,
    quoteFormat: null,
    containerImages: [],
    chainSummary: [],
    workloads: null,
    measurements: null,
    jws: 'a.b.c',
    bundle: { certChain: [rootPem] },
  } as EvidenceSnapshot;
}

describe('endpointViews', () => {
  const testdata = (file: string) =>
    readFileSync(new URL(`../../../evidence/testdata/${file}`, import.meta.url), 'utf8');

  it('labels the endpoint with the TEE its evidence names, not the one the config declares (SUP-270)', async () => {
    const [view] = await build({
      latest: [snapshotWithRoot(testdata('prod-router-azure-sev-snp-root.pem'))],
    }).endpointViews(null, new Date('2026-10-09T22:00:00.000Z'));

    expect(view?.tee).toBe('Intel TDX + H100 CC');
    expect(view?.latestEvidence?.tee).toBe('AMD SEV-SNP (Azure)');
  });

  it('labels a TDX deployment with its own branch', async () => {
    const [view] = await build({
      latest: [snapshotWithRoot(testdata('synthetic-tdx-azure-root.pem'))],
    }).endpointViews(null, new Date('2026-10-09T22:00:00.000Z'));

    expect(view?.latestEvidence?.tee).toBe('Intel TDX (Azure)');
  });
});

describe('modelViews', () => {
  it('lists the config models first, then the external ones', async () => {
    const views = await build().modelViews({ workspaceId: null, signedIn: true });

    expect(views.map((view) => view.origin)).toEqual([ModelOriginEnum.CONFIG, ModelOriginEnum.EXTERNAL]);
  });

  it('gives a config model an endpoint and no upstream', async () => {
    const [view] = await build({ external: [] }).modelViews({ workspaceId: null, signedIn: true });

    expect(view?.endpoint?.hostname).toBe('router.example.test');
    expect(view?.externalUpstream).toBeNull();
    expect(view?.tee).toBe('Intel TDX + H100 CC');
    expect(view?.available).toBe(true);
  });

  /*
   * The separation, stated as a property of the data rather than of a screen: an
   * external row has no `endpoint`, so there is nothing on it to render an
   * `evidenceState` from — the console cannot blend the two vocabularies even by
   * accident, because one of them has no value to read.
   */
  it('gives an external model an upstream and no endpoint, and no TEE label', async () => {
    const [view] = await build({ config: [] }).modelViews({ workspaceId: null, signedIn: true });

    expect(view?.endpoint).toBeNull();
    expect(view?.tee).toBeNull();
    expect(view?.externalUpstream).toMatchObject({
      name: 'partner-cloud',
      hostname: 'partner.example.test',
      status: 'verified',
    });
  });

  it('reports a denied upstream’s model as listed and unavailable', async () => {
    const [view] = await build({
      config: [],
      external: [externalEntry({ available: false, upstream: { ...externalEntry().upstream, status: 'denied' } })],
    }).modelViews({ workspaceId: null, signedIn: true });

    expect(view?.available).toBe(false);
    expect(view?.externalUpstream?.status).toBe('denied');
  });

  it('withholds the whole upstream from an anonymous caller (ruling 3)', async () => {
    const views = await build().modelViews({ workspaceId: null, signedIn: false });

    const external = views.find((view) => view.origin === ModelOriginEnum.EXTERNAL);
    expect(external?.externalUpstream).toBeNull();
    // Name, price and availability still come back: hiding the row would make
    // the public price list misstate where inference happens.
    expect(external).toMatchObject({ id: 'partner/llama-3.3-70b:snp', available: true });
    expect(external?.pricing).toEqual({ promptPer1m: '400000', completionPer1m: '800000' });
  });

  it('leaves the config models alone for an anonymous caller', async () => {
    const views = await build().modelViews({ workspaceId: null, signedIn: false });

    expect(views.find((view) => view.origin === ModelOriginEnum.CONFIG)?.endpoint?.hostname).toBe(
      'router.example.test',
    );
  });

  it('excludes external models from a TEE filter, because they declare none', async () => {
    const views = await build().modelViews({ workspaceId: null, signedIn: true, tee: 'Intel TDX + H100 CC' });

    expect(views.map((view) => view.origin)).toEqual([ModelOriginEnum.CONFIG]);
  });

  it('prices an external model in the same shape as a built-in', async () => {
    const views = await build().modelViews({ workspaceId: null, signedIn: true });

    expect(views.map((view) => Object.keys(view.pricing))).toEqual([
      ['promptPer1m', 'completionPer1m'],
      ['promptPer1m', 'completionPer1m'],
    ]);
  });
});

describe('ownEndpointView', () => {
  it('projects the endpoint this deployment publishes on', async () => {
    expect(await build().ownEndpointView(null)).toMatchObject({ id: 'ep-1', hostname: 'router.example.test' });
  });

  it('answers null when the router will not guess which endpoint is its own', async () => {
    // The chat's gate needs *the* channel, and a page that verified an arbitrary
    // endpoint and called it the channel would be the one wrong thing this
    // surface must not do.
    expect(await build({ own: null }).ownEndpointView(null)).toBeNull();
  });
});
