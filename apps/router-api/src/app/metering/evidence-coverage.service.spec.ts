import { randomUUID } from 'node:crypto';
import { loadCaseBody, loadConformanceManifest } from '@confidential-router/attestation-fixtures';
import type { ConfigType } from '@nestjs/config';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSqliteFixture, type SqliteFixture } from '../../../test/sqlite.js';
import type { routerConfig } from '../config.js';
import { RouterConfigSchema } from '../config.schema.js';
import { Endpoint } from '../db/entities/endpoint.entity.js';
import { EvidenceService } from '../evidence/evidence.service.js';
import { parseEvidenceBundle } from '../evidence/evidence-bundle.js';
import { EvidenceCoverageService } from './evidence-coverage.service.js';

const HOSTNAME = 'router.example.test';
const RENAMED = 'api.example.test';
const NOW = new Date('2026-10-20T12:00:00.000Z');

const manifest = loadConformanceManifest();

/** The conformance bundle, re-issued for one hostname at one instant. */
function bundleFor(hostname: string, issuedAt: Date): Record<string, unknown> {
  const testCase = manifest.cases.find((c) => c.id === 'valid-rsa-deployment');
  if (!testCase) throw new Error('missing conformance case');
  const raw = loadCaseBody(testCase) as Record<string, unknown>;
  const [header, payload, signature] = (raw.jws as string).split('.');
  const decoded = JSON.parse(Buffer.from(payload as string, 'base64url').toString('utf8'));
  const patched = Buffer.from(
    JSON.stringify({ ...decoded, hostname, issuedAt: issuedAt.toISOString() }),
    'utf8',
  ).toString('base64url');
  return { ...raw, hostname, jws: [header, patched, signature].join('.') };
}

function config(): ConfigType<typeof routerConfig> {
  return RouterConfigSchema.parse({
    auth: { secret: 'a'.repeat(32) },
    evidence: { freshnessWindow: '24h' },
  }) as ConfigType<typeof routerConfig>;
}

let fixture: SqliteFixture;
let evidence: EvidenceService;
let endpointId: string;

beforeEach(async () => {
  fixture = await createSqliteFixture('cr-coverage-');
  evidence = new EvidenceService(config(), fixture.dataSource);
  endpointId = randomUUID();
  await fixture.dataSource.getRepository(Endpoint).save({
    id: endpointId,
    name: 'router',
    hostname: HOSTNAME,
    evidenceUrl: null,
    declaredImages: null,
    enabled: true,
    updatedAt: NOW,
  });
});

afterEach(async () => {
  await fixture?.close();
});

async function record(hostname: string, issuedAt: Date): Promise<string> {
  const snapshot = await evidence.record(endpointId, parseEvidenceBundle(bundleFor(hostname, issuedAt), hostname));
  return snapshot.id;
}

async function rename(): Promise<void> {
  await fixture.dataSource.getRepository(Endpoint).update({ id: endpointId }, { hostname: RENAMED });
}

/**
 * The digest a generation is stamped with is a claim about what served it, and it
 * outlives the request in the ledger. After a rename the row filed under the
 * previous name is not that (SUP-437).
 */
describe('coverage after the endpoint is renamed', () => {
  it('covers a request with what the hostname it answers on published', async () => {
    const id = await record(HOSTNAME, new Date(NOW.getTime() - 60_000));
    const coverage = new EvidenceCoverageService(config(), fixture.dataSource);

    expect(await coverage.currentFor(endpointId, NOW)).toMatchObject({ snapshotId: id });
  });

  it('covers nothing until the name it moved to has published', async () => {
    await record(HOSTNAME, new Date(NOW.getTime() - 60_000));
    await rename();
    const coverage = new EvidenceCoverageService(config(), fixture.dataSource);

    expect(await coverage.currentFor(endpointId, NOW)).toBeNull();
  });

  it('prefers the current name even when the previous one published later', async () => {
    const current = await record(RENAMED, new Date(NOW.getTime() - 10 * 60_000));
    await record(HOSTNAME, new Date(NOW.getTime() - 60_000));
    await rename();
    const coverage = new EvidenceCoverageService(config(), fixture.dataSource);

    expect(await coverage.currentFor(endpointId, NOW)).toMatchObject({ snapshotId: current });
  });
});
