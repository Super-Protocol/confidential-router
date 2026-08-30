import { randomUUID } from 'node:crypto';
import { loadCaseBody, loadConformanceManifest } from '@confidential-router/attestation-fixtures';
import { NotFoundException } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSqliteFixture, type SqliteFixture } from '../../../test/sqlite.js';
import type { routerConfig } from '../config.js';
import { type RouterConfig, RouterConfigSchema } from '../config.schema.js';
import { Endpoint } from '../db/entities/endpoint.entity.js';
import { EvidenceSnapshot } from '../db/entities/evidence-snapshot.entity.js';
import { EvidenceService } from './evidence.service.js';
import { type ParsedEvidenceBundle, parseEvidenceBundle } from './evidence-bundle.js';

const HOSTNAME = 'router.example.test';
const DAY = 24 * 60 * 60 * 1000;

const manifest = loadConformanceManifest();

function fixtureBundle(id = 'valid-rsa-deployment'): Record<string, unknown> {
  const testCase = manifest.cases.find((c) => c.id === id);
  if (!testCase) throw new Error(`unknown conformance case "${id}"`);
  return loadCaseBody(testCase) as Record<string, unknown>;
}

/** The fixture bundle, optionally re-issued with a different digest or instant. */
function parsed(overrides: Partial<{ evidenceDigest: string; issuedAt: string }> = {}): ParsedEvidenceBundle {
  const raw = fixtureBundle();
  const [header, payload, signature] = (raw.jws as string).split('.');
  const decoded = JSON.parse(Buffer.from(payload as string, 'base64url').toString('utf8'));
  const patched = Buffer.from(JSON.stringify({ ...decoded, ...overrides }), 'utf8').toString('base64url');
  return parseEvidenceBundle({ ...raw, jws: [header, patched, signature].join('.') }, HOSTNAME);
}

function config(): RouterConfig {
  return RouterConfigSchema.parse({ auth: { secret: 'a'.repeat(32) }, evidence: { freshnessWindow: '24h' } });
}

let fixture: SqliteFixture;
let service: EvidenceService;
let endpointId: string;

async function seedEndpoint(dataSource: DataSource, name = 'router'): Promise<string> {
  const id = randomUUID();
  await dataSource.getRepository(Endpoint).save({
    id,
    name,
    hostname: name === 'router' ? HOSTNAME : `${name}.example.test`,
    tee: 'Intel TDX',
    evidenceUrl: null,
    enabled: true,
    updatedAt: new Date(),
  });
  return id;
}

beforeEach(async () => {
  fixture = await createSqliteFixture('cr-evidence-');
  service = new EvidenceService(config() as ConfigType<typeof routerConfig>, fixture.dataSource);
  endpointId = await seedEndpoint(fixture.dataSource);
});

afterEach(async () => {
  await fixture?.close();
});

describe('recording a snapshot', () => {
  it('stores what the endpoint published', async () => {
    const snapshot = await service.record(endpointId, parsed());

    expect(snapshot.evidenceDigest).toBe('sha256/weMdyCn3VNUosV0Mxf6P1D8iWGXVyTZ_d-5vEW4Q9qs');
    expect(snapshot.evidenceDigestHex).toHaveLength(64);
    expect(snapshot.containerImages.length).toBeGreaterThan(0);
    expect(snapshot.bundle).toMatchObject({ version: '1', kind: 'DeploymentEvidence' });
    expect(snapshot.jws).toContain('.');
  });

  it('is idempotent: re-observing a publication updates fetchedAt instead of adding a row', async () => {
    const first = await service.record(endpointId, parsed(), new Date('2026-08-30T10:00:00.000Z'));
    const again = await service.record(endpointId, parsed(), new Date('2026-08-30T10:05:00.000Z'));

    expect(again.id).toBe(first.id);
    expect(again.fetchedAt.toISOString()).toBe('2026-08-30T10:05:00.000Z');
    expect(await fixture.dataSource.getRepository(EvidenceSnapshot).count()).toBe(1);
  });

  it('adds a row when the digest changes', async () => {
    await service.record(endpointId, parsed());
    await service.record(endpointId, parsed({ evidenceDigest: `sha256/${'A'.repeat(42)}A` }));

    expect(await fixture.dataSource.getRepository(EvidenceSnapshot).count()).toBe(2);
  });

  it('keeps two endpoints’ identical publications apart', async () => {
    const other = await seedEndpoint(fixture.dataSource, 'second');

    await service.record(endpointId, parsed());
    await service.record(other, parsed());

    expect(await fixture.dataSource.getRepository(EvidenceSnapshot).count()).toBe(2);
  });
});

describe('reading snapshots', () => {
  it('has no latest snapshot before anything is fetched', async () => {
    expect(await service.latestFor(endpointId)).toBeNull();
    expect(await service.stateOf(endpointId)).toBe('NOT_PUBLISHED');
  });

  it('returns the most recently issued one', async () => {
    await service.record(endpointId, parsed({ issuedAt: '2026-08-01T00:00:00.000Z' }));
    const newest = await service.record(endpointId, parsed({ issuedAt: '2026-08-20T00:00:00.000Z' }));

    expect((await service.latestFor(endpointId))?.id).toBe(newest.id);
  });

  it('reports PUBLISHED inside the freshness window and STALE outside it', async () => {
    const now = new Date('2026-08-30T12:00:00.000Z');
    await service.record(endpointId, parsed({ issuedAt: new Date(now.getTime() - 60_000).toISOString() }));
    expect(await service.stateOf(endpointId, now)).toBe('PUBLISHED');

    await service.record(endpointId, parsed({ issuedAt: new Date(now.getTime() - 3 * DAY).toISOString() }));
    // Still PUBLISHED: the newest publication is the fresh one.
    expect(await service.stateOf(endpointId, now)).toBe('PUBLISHED');

    const stale = new Date(now.getTime() + 2 * DAY);
    expect(await service.stateOf(endpointId, stale)).toBe('STALE');
  });

  it('resolves the latest per endpoint in one call', async () => {
    const other = await seedEndpoint(fixture.dataSource, 'second');
    await service.record(endpointId, parsed({ issuedAt: '2026-08-01T00:00:00.000Z' }));
    const newest = await service.record(endpointId, parsed({ issuedAt: '2026-08-02T00:00:00.000Z' }));
    await service.record(other, parsed({ issuedAt: '2026-07-01T00:00:00.000Z' }));

    const latest = await service.latestForMany([endpointId, other]);

    expect(latest.get(endpointId)?.id).toBe(newest.id);
    expect(latest.get(other)?.issuedAt.toISOString()).toBe('2026-07-01T00:00:00.000Z');
  });

  it('pages newest first', async () => {
    for (const day of ['01', '02', '03', '04', '05']) {
      await service.record(endpointId, parsed({ issuedAt: `2026-08-${day}T00:00:00.000Z` }));
    }

    const first = await service.snapshots(endpointId, 2);
    expect(first.nodes.map((node) => node.issuedAt.toISOString())).toEqual([
      '2026-08-05T00:00:00.000Z',
      '2026-08-04T00:00:00.000Z',
    ]);
    expect(first.hasNextPage).toBe(true);

    const second = await service.snapshots(endpointId, 2, first.endCursor);
    expect(second.nodes.map((node) => node.issuedAt.toISOString())).toEqual([
      '2026-08-03T00:00:00.000Z',
      '2026-08-02T00:00:00.000Z',
    ]);

    const third = await service.snapshots(endpointId, 2, second.endCursor);
    expect(third.hasNextPage).toBe(false);
  });

  it('treats an unreadable cursor as the first page', async () => {
    await service.record(endpointId, parsed());

    expect((await service.snapshots(endpointId, 10, 'not-a-cursor')).nodes).toHaveLength(1);
  });
});

describe('digest history', () => {
  it('collapses re-publications of the same deployment into one entry', async () => {
    const other = `sha256/${'B'.repeat(42)}A`;
    await service.record(endpointId, parsed({ issuedAt: '2026-08-01T00:00:00.000Z' }));
    await service.record(endpointId, parsed({ issuedAt: '2026-08-02T00:00:00.000Z' }));
    await service.record(endpointId, parsed({ issuedAt: '2026-08-03T00:00:00.000Z', evidenceDigest: other }));

    const history = await service.digestHistory(endpointId);

    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ evidenceDigest: other, snapshots: 1 });
    expect(history[1]).toMatchObject({
      evidenceDigest: 'sha256/weMdyCn3VNUosV0Mxf6P1D8iWGXVyTZ_d-5vEW4Q9qs',
      snapshots: 2,
    });
    expect(history[1]?.firstIssuedAt.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(history[1]?.lastIssuedAt.toISOString()).toBe('2026-08-02T00:00:00.000Z');
  });
});

describe('resolving an endpoint', () => {
  it('finds one by name or by hostname', async () => {
    expect((await service.endpointByNameOrHostname('router'))?.id).toBe(endpointId);
    expect((await service.endpointByNameOrHostname(HOSTNAME))?.id).toBe(endpointId);
    expect(await service.endpointByNameOrHostname('nope')).toBeNull();
  });

  it('404s on an unknown id', async () => {
    await expect(service.endpointOrThrow(randomUUID())).rejects.toThrow(NotFoundException);
  });

  it('lists only the endpoints the config still declares', async () => {
    await fixture.dataSource.getRepository(Endpoint).update({ id: endpointId }, { enabled: false });

    expect(await service.activeEndpoints()).toHaveLength(0);
  });
});
