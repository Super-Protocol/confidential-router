import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type Catalog,
  createTestDataSource,
  seedCatalog,
  seedExternalEndpoint,
  seedExternalSnapshot,
  seedGeneration,
  testConfig,
} from '../../../test/seed.js';
import { EvidenceSnapshot } from '../db/entities/evidence-snapshot.entity.js';
import { ExternalEndpoint } from '../db/entities/external-endpoint.entity.js';
import { UserPreferences } from '../db/entities/user-preferences.entity.js';
import { WorkspaceMember } from '../db/entities/workspace-member.entity.js';
import { EvidenceRetentionService } from './evidence-retention.service.js';
import { EvidenceRetentionHealth } from './evidence-retention-health.js';

const NOW = new Date('2026-10-24T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

let dataSource: DataSource;
let health: EvidenceRetentionHealth;
let retention: EvidenceRetentionService;
let catalog: Catalog;

beforeEach(async () => {
  dataSource = await createTestDataSource();
  health = new EvidenceRetentionHealth();
  retention = new EvidenceRetentionService(testConfig(), dataSource, health);
  catalog = await seedCatalog(dataSource);
});

afterEach(async () => {
  await dataSource.destroy();
});

/** `issuedAt` this many days before {@link NOW}. */
function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

/**
 * One archived publication of the catalogue's endpoint.
 *
 * Always a *second* snapshot of that endpoint, because `seedCatalog`'s is the
 * endpoint's newest and the sweep exempts the newest on purpose — a fixture that
 * ignored that would be testing the exemption, not the window. `issuedAt` is in
 * the past, so these rows never overtake it.
 */
async function seedArchivedSnapshot(issuedAt: Date, endpointId = catalog.endpointId): Promise<string> {
  const id = randomUUID();
  await dataSource.getRepository(EvidenceSnapshot).insert({
    id,
    endpointId,
    fetchedAt: issuedAt,
    issuedAt,
    evidenceDigest: `sha256/archived-${id}`,
    evidenceDigestHex: 'ab'.repeat(32),
    certFingerprint: 'sha256/archived-leaf',
    quoteFormat: 'intel-tdx-quote-v5',
    containerImages: ['ghcr.io/example/router@sha256:old'],
    chainSummary: [],
    measurements: { MRTD: 'eeff' },
    jws: 'eyJhbGciOiJFUzI1NksifQ.archived.signature',
    bundle: { version: 1, archived: true },
  });
  return id;
}

/** An account of a workspace, with its retention window if it has set one. */
async function seedMember(workspaceId: string, days?: number): Promise<string> {
  const userId = randomUUID();
  await dataSource
    .getRepository(WorkspaceMember)
    .insert({ workspaceId, userId, role: 'owner', createdAt: new Date(0) });
  if (days !== undefined) {
    await dataSource.getRepository(UserPreferences).insert({
      userId,
      archiveEvidence: true,
      evidenceRetentionDays: days,
      notifyOnMeasurementChange: true,
      desktopNotifications: false,
      emailReceipts: true,
      updatedAt: new Date(0),
    });
  }
  return userId;
}

async function reload(id: string): Promise<EvidenceSnapshot> {
  const row = await dataSource.getRepository(EvidenceSnapshot).findOne({ where: { id } });
  if (!row) throw new Error(`Snapshot ${id} is gone — the sweep must strip rows, never delete them.`);
  return row;
}

describe('the retention boundary', () => {
  it('leaves a bundle one day inside the window alone', async () => {
    const id = await seedArchivedSnapshot(daysAgo(89));
    await seedMember(catalog.workspaceId);
    await seedGeneration(dataSource, catalog, { createdAt: daysAgo(89) });

    const report = await retention.sweep(NOW);

    expect(report.stripped).toBe(0);
    const row = await reload(id);
    expect(row.jws).not.toBeNull();
    expect(row.bundle).not.toBeNull();
    expect(row.payloadStrippedAt).toBeNull();
  });

  it('strips a bundle one day outside it', async () => {
    const id = await seedArchivedSnapshot(daysAgo(91));
    await seedMember(catalog.workspaceId);

    const report = await retention.sweep(NOW);

    expect(report.stripped).toBe(1);
    const row = await reload(id);
    expect(row.jws).toBeNull();
    expect(row.bundle).toBeNull();
    expect(row.payloadStrippedAt).toEqual(NOW);
  });

  it('keeps the digests on both sides of it, which is what `/privacy` promises', async () => {
    const inside = await seedArchivedSnapshot(daysAgo(89));
    const outside = await seedArchivedSnapshot(daysAgo(91));
    await seedMember(catalog.workspaceId);

    await retention.sweep(NOW);

    for (const id of [inside, outside]) {
      const row = await reload(id);
      expect(row.evidenceDigest).toBe(`sha256/archived-${id}`);
      expect(row.evidenceDigestHex).toBe('ab'.repeat(32));
      expect(row.certFingerprint).toBe('sha256/archived-leaf');
      expect(row.issuedAt).toBeInstanceOf(Date);
      // The summaries beside the digests are not the raw bundle and are not
      // governed by the preference — the console's history renders them for a
      // publication whose document is long gone.
      expect(row.containerImages).toEqual(['ghcr.io/example/router@sha256:old']);
      expect(row.measurements).toEqual({ MRTD: 'eeff' });
    }
  });

  it('measures the window from `issuedAt`, not from the last time the poller saw it', async () => {
    // `fetchedAt` moves forward every time an unchanged publication is
    // re-observed, so a window measured from it would never close on an endpoint
    // that keeps republishing the same bundle.
    const id = await seedArchivedSnapshot(daysAgo(120));
    await dataSource.getRepository(EvidenceSnapshot).update({ id }, { fetchedAt: NOW });

    expect((await retention.sweep(NOW)).stripped).toBe(1);
  });
});

describe('whose preference governs a shared publication', () => {
  it('holds a bundle for the longest window of the accounts that hold it', async () => {
    const id = await seedArchivedSnapshot(daysAgo(100));
    await seedMember(catalog.workspaceId, 30);
    await seedMember(catalog.workspaceId, 365);
    await seedGeneration(dataSource, catalog, { createdAt: daysAgo(100) });
    await dataSource
      .getRepository('generations')
      .update({ evidenceSnapshotId: catalog.snapshotId }, { evidenceSnapshotId: id });

    const report = await retention.sweep(NOW);

    // 30 days has passed for one holder; the other is still inside 365, and
    // stripping now would shorten a window they were promised.
    expect(report).toMatchObject({ stripped: 0, held: 1 });
    expect((await reload(id)).bundle).not.toBeNull();
  });

  it('strips it once the longest window has closed too', async () => {
    const id = await seedArchivedSnapshot(daysAgo(400));
    await seedMember(catalog.workspaceId, 30);
    await seedMember(catalog.workspaceId, 365);
    await seedGeneration(dataSource, catalog, { createdAt: daysAgo(400) });
    await dataSource
      .getRepository('generations')
      .update({ evidenceSnapshotId: catalog.snapshotId }, { evidenceSnapshotId: id });

    expect((await retention.sweep(NOW)).stripped).toBe(1);
  });

  it('gives an account that has never opened Preferences the published default', async () => {
    const id = await seedArchivedSnapshot(daysAgo(100));
    // No `user_preferences` row, and a shorter window stored by somebody else so
    // the prefilter cannot be what keeps this row: the fallback has to be 90.
    await seedMember(catalog.workspaceId);
    await seedMember((await seedCatalog(dataSource)).workspaceId, 1);
    await seedGeneration(dataSource, catalog, { createdAt: daysAgo(100) });
    await dataSource
      .getRepository('generations')
      .update({ evidenceSnapshotId: catalog.snapshotId }, { evidenceSnapshotId: id });

    expect((await retention.sweep(NOW)).stripped).toBe(1);
    expect((await reload(id)).bundle).toBeNull();
  });

  it('sweeps a publication no account holds on the default window', async () => {
    // Polled and never served to anybody — nobody's archive, so no preference
    // speaks for it, and keeping it forever is storage with no promise attached.
    const fresh = await seedArchivedSnapshot(daysAgo(89));
    const stale = await seedArchivedSnapshot(daysAgo(91));

    await retention.sweep(NOW);

    expect((await reload(fresh)).bundle).not.toBeNull();
    expect((await reload(stale)).bundle).toBeNull();
  });
});

describe('what the sweep never touches', () => {
  it('leaves an endpoint’s live publication alone however old it is', async () => {
    // `seedCatalog`'s snapshot is the newest for its endpoint, which is what
    // `GET /v1/evidence`, `GET /v1/models` and the console badge all read.
    await dataSource
      .getRepository(EvidenceSnapshot)
      .update({ id: catalog.snapshotId }, { issuedAt: daysAgo(500), fetchedAt: daysAgo(500) });

    const report = await retention.sweep(NOW);

    expect(report).toMatchObject({ stripped: 0, inUse: 1 });
    expect((await reload(catalog.snapshotId)).bundle).not.toBeNull();
  });

  it('leaves the publication an external endpoint pins, and strips the one it superseded', async () => {
    const upstream = await seedExternalEndpoint(dataSource, { pinnedEvidenceDigest: 'sha256/pinned' });
    const pinned = await seedExternalSnapshot(dataSource, upstream.id, 'sha256/pinned');
    const superseded = await seedExternalSnapshot(dataSource, upstream.id, 'sha256/superseded');
    // The pinned document is the older of the two, so recency alone would have
    // kept the wrong one: `latestAdmitted` keys on the digest a verdict saw.
    await dataSource
      .getRepository(EvidenceSnapshot)
      .update({ id: pinned }, { issuedAt: daysAgo(400), fetchedAt: daysAgo(400) });
    await dataSource
      .getRepository(EvidenceSnapshot)
      .update({ id: superseded }, { issuedAt: daysAgo(300), fetchedAt: daysAgo(300) });
    await dataSource
      .getRepository(ExternalEndpoint)
      .update({ id: upstream.id }, { evidenceDigestSeen: 'sha256/pinned' });

    await retention.sweep(NOW);

    expect((await reload(pinned)).bundle).not.toBeNull();
    expect((await reload(superseded)).bundle).toBeNull();
  });

  it('holds an upstream’s superseded publication for the window of the accounts it served', async () => {
    const upstream = await seedExternalEndpoint(dataSource, { pinnedEvidenceDigest: 'sha256/current' });
    const current = await seedExternalSnapshot(dataSource, upstream.id, 'sha256/current');
    const earlier = await seedExternalSnapshot(dataSource, upstream.id, 'sha256/earlier');
    await dataSource
      .getRepository(EvidenceSnapshot)
      .update({ id: earlier }, { issuedAt: daysAgo(100), fetchedAt: daysAgo(100) });
    await seedMember(catalog.workspaceId, 365);
    // An external generation carries no snapshot id — only the digest its
    // verdict saw (ADR-008 §4) — so this is the other half of the holder lookup.
    await seedGeneration(dataSource, catalog, {
      createdAt: daysAgo(100),
      externalEndpointId: upstream.id,
      evidenceDigest: 'sha256/earlier',
    });

    const report = await retention.sweep(NOW);

    expect(report.held).toBe(1);
    expect((await reload(earlier)).bundle).not.toBeNull();
    expect((await reload(current)).bundle).not.toBeNull();
  });

  it('never deletes a row, so an endpoint keeps its digest history', async () => {
    await seedArchivedSnapshot(daysAgo(400));
    await seedArchivedSnapshot(daysAgo(500));

    await retention.sweep(NOW);

    expect(await dataSource.getRepository(EvidenceSnapshot).count()).toBe(3);
  });
});

describe('a pass an operator can see', () => {
  it('records what it stripped for `/health`', async () => {
    await seedArchivedSnapshot(daysAgo(400));

    await retention.runPass();

    expect(health.status()).toMatchObject({ stripped: 1, failed: 0 });
    expect(health.status().lastSweepAt).not.toBeNull();
  });

  it('reports a pass that stripped nothing, which is how "is it running" is answered', async () => {
    await retention.runPass();

    expect(health.status()).toMatchObject({ stripped: 0, failed: 0 });
    expect(health.status().lastSweepAt).not.toBeNull();
  });

  it('counts a failed pass instead of letting it escape a timer', async () => {
    await dataSource.destroy();

    await expect(retention.runPass()).resolves.toBeUndefined();

    expect(health.status()).toMatchObject({ failed: 1, stripped: 0 });
    // So `afterEach` does not destroy it twice.
    dataSource = await createTestDataSource();
  });

  it('says `enabled` only once a timer exists', () => {
    expect(health.status().status).toBe('disabled');

    retention.onApplicationBootstrap();

    expect(health.status().status).toBe('enabled');
    retention.onModuleDestroy();
  });

  it('says `disabled` and warns when the interval is 0', () => {
    const off = new EvidenceRetentionService(
      testConfig({ CR_API_EVIDENCE__RETENTION_SWEEP_INTERVAL: '0ms' }),
      dataSource,
      health,
    );

    off.onApplicationBootstrap();

    expect(health.status().status).toBe('disabled');
  });
});

describe('draining a backlog', () => {
  it('reaches the rows behind a page of held ones instead of stalling on them', async () => {
    // The failure this is here for: cap the *read* instead of the write, and a
    // contiguous run of rows one long-window account holds fills every pass's
    // candidate set forever while the rows behind them are never looked at.
    const held = [await seedArchivedSnapshot(daysAgo(300)), await seedArchivedSnapshot(daysAgo(299))];
    const strippable = [await seedArchivedSnapshot(daysAgo(200)), await seedArchivedSnapshot(daysAgo(199))];
    await seedMember(catalog.workspaceId, 365);
    for (const id of held) {
      await seedGeneration(dataSource, catalog, { createdAt: daysAgo(300) });
      await dataSource
        .getRepository('generations')
        .update({ evidenceSnapshotId: catalog.snapshotId }, { evidenceSnapshotId: id });
    }

    // Two rows per page, so the held pair is a whole page of its own.
    const report = await retention.sweep(NOW, { pageSize: 2 });

    expect(report).toMatchObject({ stripped: 2, held: 2 });
    for (const id of strippable) {
      expect((await reload(id)).bundle).toBeNull();
    }
    for (const id of held) {
      expect((await reload(id)).bundle).not.toBeNull();
    }
  });

  it('examines each candidate once, however small the page', async () => {
    // A cursor that only carried `issuedAt` would repeat or lose a row where two
    // publications share a millisecond; `id` is the tiebreak.
    const sameMoment = daysAgo(200);
    await seedArchivedSnapshot(sameMoment);
    await seedArchivedSnapshot(sameMoment);
    await seedArchivedSnapshot(sameMoment);

    const report = await retention.sweep(NOW, { pageSize: 1 });

    expect(report).toMatchObject({ examined: 3, stripped: 3 });
  });
});

describe('running it twice', () => {
  it('strips nothing the second time and says so', async () => {
    await seedArchivedSnapshot(daysAgo(400));

    expect((await retention.sweep(NOW)).stripped).toBe(1);
    // The candidate query excludes rows already stripped, so a steady state is a
    // pass that examines nothing rather than one that re-writes the same rows.
    expect(await retention.sweep(NOW)).toMatchObject({ examined: 0, stripped: 0 });
  });

  it('does not move a strip time that another pass already recorded', async () => {
    const id = await seedArchivedSnapshot(daysAgo(400));

    await retention.sweep(NOW);
    const later = new Date(NOW.getTime() + 7 * DAY_MS);
    await retention.sweep(later);

    expect((await reload(id)).payloadStrippedAt).toEqual(NOW);
  });
});
