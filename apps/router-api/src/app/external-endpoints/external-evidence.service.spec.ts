import { randomUUID } from 'node:crypto';
import { loadCaseBody, loadConformanceManifest } from '@confidential-router/attestation-fixtures';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDataSource } from '../../../test/seed.js';
import { EvidenceSnapshot } from '../db/entities/evidence-snapshot.entity.js';
import { ExternalEndpoint, type ExternalEndpointStatus } from '../db/entities/external-endpoint.entity.js';
import { parseEvidenceBundle } from '../evidence/index.js';
import { ExternalEvidenceService } from './external-evidence.service.js';

/**
 * The upstream whose bundle these fixtures belong to. The conformance bundles
 * are issued for `router.example.test`, and `parseEvidenceBundle` refuses one
 * that names a different host — which is a property worth inheriting here rather
 * than working around.
 */
const HOSTNAME = 'router.example.test';
const MEASUREMENT = 'a'.repeat(64);

const manifest = loadConformanceManifest();

function bundle(id = 'valid-rsa-deployment'): Record<string, unknown> {
  const testCase = manifest.cases.find((c) => c.id === id);
  if (!testCase) throw new Error(`unknown conformance case "${id}"`);
  return loadCaseBody(testCase) as Record<string, unknown>;
}

/** The leaf the fixture's signed payload claims — what a verdict would have pinned. */
function leafOf(raw: Record<string, unknown> = bundle()): string {
  return parseEvidenceBundle(raw, HOSTNAME).certFingerprint;
}

function digestOf(raw: Record<string, unknown> = bundle()): string {
  return parseEvidenceBundle(raw, HOSTNAME).digest.canonical;
}

let dataSource: DataSource;
let service: ExternalEvidenceService;
let fetcher: ReturnType<typeof vi.fn>;

/**
 * Stands in for the upstream's `/.well-known/swarm-evidence`.
 *
 * A fresh `Response` per call rather than one shared instance: a body is a
 * stream and reads once, so a reused response makes the second fetch of a poll
 * fail for a reason that has nothing to do with the code under test.
 */
function serving(body: unknown, status = 200) {
  // The `url` parameter is declared though the stub ignores it, so a test can
  // assert on what was asked for.
  return vi.fn(
    async (_url: string) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  );
}

async function endpoint(overrides: Partial<ExternalEndpoint> = {}): Promise<ExternalEndpoint> {
  const now = new Date('2026-10-06T12:00:00.000Z');
  const row: ExternalEndpoint = {
    id: randomUUID(),
    name: 'partner-cloud',
    baseUrl: `https://${HOSTNAME}`,
    hostname: HOSTNAME,
    listenPort: 19_000,
    enabled: true,
    status: 'verified' as ExternalEndpointStatus,
    lastCheckedAt: now,
    lastStage: null,
    lastReason: null,
    measurementSeen: MEASUREMENT,
    measurementSource: 'operator-pinned',
    evidenceDigestSeen: digestOf(),
    pinnedCertFingerprint: leafOf(),
    observedCertFingerprint: leafOf(),
    apiKeyCiphertext: 'v1.whatever',
    apiKeyPrefix: 'sk-upstr',
    createdByUserId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as ExternalEndpoint;
  await dataSource.getRepository(ExternalEndpoint).save(row);
  return row;
}

beforeEach(async () => {
  dataSource = await createTestDataSource();
  service = new ExternalEvidenceService(dataSource);
  fetcher = serving(bundle());
  vi.stubGlobal('fetch', fetcher);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await dataSource?.destroy();
});

describe('filing an upstream’s published bundle', () => {
  it('stores what it published, and nothing that could be read as a verdict', async () => {
    const row = await endpoint();

    const report = await service.refreshAll();

    expect(report).toEqual({ polled: 1, stored: 1, failed: 0 });
    const [stored] = await dataSource.getRepository(EvidenceSnapshot).find();
    expect(stored).toMatchObject({
      // Filed under the upstream, never under one of our own endpoints: the two
      // namespaces are separate so an upstream's publications cannot turn up in
      // this deployment's own digest history (ADR-008 §6).
      externalEndpointId: row.id,
      endpointId: null,
      evidenceDigest: digestOf(),
      certFingerprint: leafOf(),
    });
    expect(stored?.workloads).toBeDefined();
    // `evidence_snapshots` records what was published and never whether it was
    // any good; there is no verdict column to write and none is wanted.
    expect(Object.keys(stored ?? {})).not.toContain('verified');
  });

  it('is idempotent: re-observing a publication moves fetchedAt and adds no row', async () => {
    const row = await endpoint();
    await service.refresh(row, new Date('2026-10-06T12:00:00.000Z'));

    await service.refresh(row, new Date('2026-10-06T12:05:00.000Z'));

    const stored = await dataSource.getRepository(EvidenceSnapshot).find();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.fetchedAt.toISOString()).toBe('2026-10-06T12:05:00.000Z');
  });

  it('refuses a bundle claiming a leaf the sidecar did not observe', async () => {
    const other = `sha256/${Buffer.alloc(32, 9).toString('base64url')}`;
    const row = await endpoint({ pinnedCertFingerprint: other, observedCertFingerprint: other });

    // The whole of this service's judgement, and it is a string comparison rather
    // than a signature check: a document about some other channel is not a
    // document about the channel this verdict covers, whatever else is true of it.
    await expect(service.refresh(row)).rejects.toThrow(/not a document about the channel/);
    expect(await dataSource.getRepository(EvidenceSnapshot).count()).toBe(0);
  });

  it('refuses a bundle naming a different host, because the parser does', async () => {
    const row = await endpoint({ hostname: 'elsewhere.example' });

    await expect(service.refresh(row)).rejects.toThrow(/does not match endpoint/);
  });

  it('files a bundle whose signature a verifier would reject — that is not this router’s question', async () => {
    const raw = bundle('jws-bad-signature');
    vi.stubGlobal('fetch', serving(raw));
    const row = await endpoint({
      pinnedCertFingerprint: leafOf(raw),
      observedCertFingerprint: leafOf(raw),
      evidenceDigestSeen: digestOf(raw),
    });

    await service.refresh(row);

    // ADR-002's architectural rule: the verdict is the sidecar's, and it already
    // reached one. Declining to file this would be this router forming a second
    // opinion about an upstream's cryptography.
    expect(await dataSource.getRepository(EvidenceSnapshot).count()).toBe(1);
  });
});

describe('which upstreams are polled at all', () => {
  it('skips one with no verdict: there is no observed leaf to bind a fetched bundle to', async () => {
    await endpoint({
      status: 'pending',
      evidenceDigestSeen: null,
      pinnedCertFingerprint: null,
      observedCertFingerprint: null,
    });

    expect(await service.refreshAll()).toEqual({ polled: 0, stored: 0, failed: 0 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('skips one denied in the pipeline, and a disabled one, for the same reason', async () => {
    await endpoint({
      name: 'denied',
      status: 'denied',
      lastStage: 'tls-fingerprint',
      pinnedCertFingerprint: null,
      observedCertFingerprint: null,
    });
    await endpoint({ name: 'off', enabled: false, status: 'disabled' });

    expect(await service.refreshAll()).toMatchObject({ polled: 0 });
  });

  it('files the deployment a two-factor refusal asks an admin to approve (SUP-252)', async () => {
    // `digest-not-pinned` on a fresh registration and `digest-mismatch` after a
    // redeploy: the cryptography held, a trust factor refused, and the summary is
    // exactly what the admin reads before pinning. Bound to the observed leaf —
    // there is no egress pin yet, and none is pretended.
    const pending = await endpoint({
      name: 'awaiting-approval',
      status: 'pending',
      lastStage: 'digest-not-pinned',
      pinnedCertFingerprint: null,
      observedCertFingerprint: leafOf(),
    });

    expect(await service.refreshAll()).toEqual({ polled: 1, stored: 1, failed: 0 });
    const [stored] = await dataSource.getRepository(EvidenceSnapshot).find();
    expect(stored).toMatchObject({ externalEndpointId: pending.id, evidenceDigest: digestOf() });
  });

  it('skips one whose current publication is already filed', async () => {
    await endpoint();
    await service.refreshAll();
    fetcher.mockClear();

    expect(await service.refreshAll()).toEqual({ polled: 0, stored: 0, failed: 0 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not re-ask an upstream that served something unbindable, until the verdict moves', async () => {
    vi.stubGlobal('fetch', serving({ not: 'a bundle' }));
    const row = await endpoint();

    expect(await service.refreshAll()).toEqual({ polled: 1, stored: 0, failed: 1 });
    // A minute later, and the upstream is still publishing the same thing: the
    // poll would otherwise retry a broken publication for ever.
    expect(await service.refreshAll()).toEqual({ polled: 0, stored: 0, failed: 0 });

    // A new verdict digest is a new question, so it is worth asking again.
    vi.stubGlobal('fetch', serving(bundle()));
    await dataSource
      .getRepository(ExternalEndpoint)
      .update({ id: row.id }, { evidenceDigestSeen: 'sha256/something-else-entirely' });
    expect(await service.refreshAll()).toMatchObject({ polled: 1 });
  });

  it('keeps asking an upstream that was merely unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('connect ECONNREFUSED'))),
    );
    await endpoint();

    expect(await service.refreshAll()).toEqual({ polled: 1, stored: 0, failed: 1 });
    // An upstream mid-restart is unreachable, not wrong: one 503 must not
    // suppress its summary until it next redeploys under a new digest.
    expect(await service.refreshAll()).toEqual({ polled: 1, stored: 0, failed: 1 });

    vi.stubGlobal('fetch', serving(bundle()));
    expect(await service.refreshAll()).toEqual({ polled: 1, stored: 1, failed: 0 });
  });

  it('stops asking once the upstream has moved past the publication the verdict names', async () => {
    const fetcher = serving(bundle());
    vi.stubGlobal('fetch', fetcher);
    // The sidecar's last check saw one digest; the upstream has since republished,
    // so a fetch can only ever return the newer one.
    await endpoint({ evidenceDigestSeen: 'sha256/what-the-last-verdict-saw' });

    expect(await service.refreshAll()).toEqual({ polled: 1, stored: 1, failed: 0 });
    // Asking again cannot produce the publication the verdict named; the next
    // verdict will name the one that is actually being served.
    expect(await service.refreshAll()).toEqual({ polled: 0, stored: 0, failed: 0 });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('asks the upstream’s own authority, port included', async () => {
    const fetcher = serving(bundle());
    vi.stubGlobal('fetch', fetcher);
    await endpoint({ baseUrl: `https://${HOSTNAME}:8443` });

    await service.refreshAll();

    // Defaulting to 443 would make an upstream published on another port one this
    // router could never summarise, while the sidecar pins it happily.
    expect(fetcher.mock.calls[0]?.[0]).toBe(`https://${HOSTNAME}:8443/.well-known/swarm-evidence`);
  });

  it('lets one unreachable upstream not stop the others', async () => {
    const reachable = await endpoint({ name: 'reachable' });
    await endpoint({ name: 'unreachable', hostname: 'down.example', baseUrl: 'https://down.example' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('down.example')
          ? Promise.reject(new Error('connect ECONNREFUSED'))
          : new Response(JSON.stringify(bundle()), { status: 200 }),
      ),
    );

    expect(await service.refreshAll()).toEqual({ polled: 2, stored: 1, failed: 1 });
    expect(
      await dataSource.getRepository(EvidenceSnapshot).findOne({ where: { externalEndpointId: reachable.id } }),
    ).not.toBeNull();
  });
});

describe('what the console reads back', () => {
  it('answers each (endpoint, digest) pair the page asked for, and nothing else', async () => {
    const row = await endpoint();
    await service.refreshAll();

    const summaries = await service.summariesFor([
      { externalEndpointId: row.id, evidenceDigest: digestOf() },
      { externalEndpointId: row.id, evidenceDigest: 'sha256/never-published' },
    ]);

    expect(summaries.get(row.id)?.get(digestOf())?.evidenceDigest).toBe(digestOf());
    expect(summaries.get(row.id)?.get('sha256/never-published')).toBeUndefined();
  });

  it('asks nothing of the database when the page needs no summary', async () => {
    expect((await service.summariesFor([])).size).toBe(0);
  });
});
