import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSqliteFixture, type SqliteFixture } from '../../../test/sqlite.js';
import { Endpoint } from '../db/entities/endpoint.entity.js';
import { Generation } from '../db/entities/generation.entity.js';
import { Model } from '../db/entities/model.entity.js';
import { Workspace } from '../db/entities/workspace.entity.js';
import { coverageOf, EvidenceCoverageStatsService } from './coverage.service.js';

describe('coverageOf', () => {
  it('is the share of generations served while a fresh snapshot existed', () => {
    expect(coverageOf(3, 4)).toEqual({ covered: 3, requests: 4, ratio: 0.75 });
  });

  it('is 0, not 1, for a window with no generations', () => {
    // An empty window has no evidence behind it; reporting full coverage would
    // put a reassuring number on a screen backed by nothing.
    expect(coverageOf(0, 0)).toEqual({ covered: 0, requests: 0, ratio: 0 });
  });

  it('is 1 when every generation was covered', () => {
    expect(coverageOf(7, 7).ratio).toBe(1);
  });

  it('is 0 when none was', () => {
    expect(coverageOf(0, 5).ratio).toBe(0);
  });
});

const NOW = new Date('2026-08-30T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const MODEL_ID = 'meta/llama-3.3-70b-instruct:tdx';

let fixture: SqliteFixture;
let stats: EvidenceCoverageStatsService;
let workspaceId: string;
let endpointId: string;
let otherEndpointId: string;

/**
 * A metered generation. `evidenceSnapshotId` is what the metering path stamps
 * when the endpoint had a fresh bundle published at request time; here it is
 * simulated with a plain id, because coverage counts stamps and nothing else.
 */
async function generation(options: {
  createdAt: Date;
  covered: boolean;
  endpointId?: string;
  tokens?: number;
  workspaceId?: string;
}): Promise<void> {
  await fixture.dataSource.getRepository(Generation).save({
    id: `gen-${randomUUID()}`,
    workspaceId: options.workspaceId ?? workspaceId,
    apiKeyId: null,
    modelId: MODEL_ID,
    endpointId: options.endpointId ?? endpointId,
    evidenceSnapshotId: options.covered ? randomUUID() : null,
    evidenceDigest: options.covered ? `sha256/${'A'.repeat(43)}` : null,
    promptTokens: options.tokens ?? 0,
    completionTokens: 0,
    costMicros: 0,
    promptPer1mMicros: 280000,
    completionPer1mMicros: 420000,
    streamed: false,
    status: 'ok',
    latencyMs: 0,
    createdAt: options.createdAt,
  });
}

beforeEach(async () => {
  fixture = await createSqliteFixture('cr-coverage-');
  stats = new EvidenceCoverageStatsService(fixture.dataSource);

  workspaceId = randomUUID();
  await fixture.dataSource
    .getRepository(Workspace)
    .save({ id: workspaceId, name: 'w', slug: `w-${workspaceId.slice(0, 8)}`, balanceMicros: 0, createdAt: NOW });

  endpointId = randomUUID();
  otherEndpointId = randomUUID();
  for (const [id, name] of [
    [endpointId, 'llama-33-70b'],
    [otherEndpointId, 'qwen25-72b'],
  ] as const) {
    await fixture.dataSource.getRepository(Endpoint).save({
      id,
      name,
      hostname: `${name}.tee.swarm.cloud`,
      tee: 'Intel TDX',
      evidenceUrl: null,
      enabled: true,
      updatedAt: NOW,
    });
  }

  await fixture.dataSource.getRepository(Model).save({
    id: MODEL_ID,
    name: 'Llama 3.3 70B Instruct',
    litellmModel: 'vllm/llama-3.3-70b-instruct',
    endpointId,
    contextLength: 131072,
    capabilities: ['chat'],
    promptPer1mMicros: 280000,
    completionPer1mMicros: 420000,
    tee: 'Intel TDX',
    enabled: true,
    updatedAt: NOW,
  });

  // `evidenceSnapshotId` has a nullable foreign key to a table this test does
  // not populate; the stamps above stand in for real snapshots.
  await fixture.dataSource.query('PRAGMA foreign_keys = OFF');
});

afterEach(async () => {
  await fixture?.close();
});

describe('EvidenceCoverageStatsService', () => {
  const window = () => ({ workspaceId, from: new Date(NOW.getTime() - 24 * HOUR), to: NOW });

  it('counts the share of generations served while a bundle was published', async () => {
    await generation({ createdAt: new Date(NOW.getTime() - HOUR), covered: true });
    await generation({ createdAt: new Date(NOW.getTime() - 2 * HOUR), covered: true });
    await generation({ createdAt: new Date(NOW.getTime() - 3 * HOUR), covered: false });

    await expect(stats.summary(window())).resolves.toEqual({ requests: 3, covered: 2, ratio: 2 / 3 });
  });

  it('ignores generations outside the window', async () => {
    await generation({ createdAt: new Date(NOW.getTime() - 48 * HOUR), covered: true });

    await expect(stats.summary(window())).resolves.toEqual({ requests: 0, covered: 0, ratio: 0 });
  });

  it('excludes the upper bound and includes the lower one', async () => {
    await generation({ createdAt: NOW, covered: true });
    await generation({ createdAt: new Date(NOW.getTime() - 24 * HOUR), covered: true });

    await expect(stats.summary(window())).resolves.toMatchObject({ requests: 1 });
  });

  it('never counts another workspace’s generations', async () => {
    const other = randomUUID();
    await fixture.dataSource
      .getRepository(Workspace)
      .save({ id: other, name: 'other', slug: 'other', balanceMicros: 0, createdAt: NOW });
    await generation({ createdAt: new Date(NOW.getTime() - HOUR), covered: true, workspaceId: other });

    await expect(stats.summary(window())).resolves.toEqual({ requests: 0, covered: 0, ratio: 0 });
  });

  it('narrows to one endpoint when asked', async () => {
    await generation({ createdAt: new Date(NOW.getTime() - HOUR), covered: true });
    await generation({ createdAt: new Date(NOW.getTime() - HOUR), covered: false, endpointId: otherEndpointId });

    await expect(stats.summary({ ...window(), endpointId })).resolves.toEqual({ requests: 1, covered: 1, ratio: 1 });
  });

  it('sums the tokens routed through each endpoint', async () => {
    await generation({ createdAt: new Date(NOW.getTime() - HOUR), covered: true, tokens: 100 });
    await generation({ createdAt: new Date(NOW.getTime() - HOUR), covered: false, tokens: 50 });
    await generation({
      createdAt: new Date(NOW.getTime() - HOUR),
      covered: true,
      tokens: 7,
      endpointId: otherEndpointId,
    });

    const tokens = await stats.tokensByEndpoint(window());

    expect(tokens.get(endpointId)).toBe(150);
    expect(tokens.get(otherEndpointId)).toBe(7);
  });

  it('reports no tokens for an endpoint nothing was routed through', async () => {
    expect((await stats.tokensByEndpoint(window())).get(endpointId)).toBeUndefined();
  });
});
