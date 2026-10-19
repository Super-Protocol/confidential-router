import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSqliteFixture, type SqliteFixture } from '../../../test/sqlite.js';
import type { RouterConfig } from '../config.schema.js';
import { Endpoint } from '../db/entities/endpoint.entity.js';
import { Generation, type GenerationStatus } from '../db/entities/generation.entity.js';
import { Model } from '../db/entities/model.entity.js';
import { Workspace } from '../db/entities/workspace.entity.js';
import { IncompleteGenerationSweeper, NO_RESPONSE_CODE } from './incomplete-generations.service.js';

const NOW = new Date('2026-10-19T20:00:00.000Z');
const MINUTE = 60 * 1000;
const MODEL_ID = 'qwen/qwen3-coder-next';

let fixture: SqliteFixture;
let sweeper: IncompleteGenerationSweeper;
let workspaceId: string;
let endpointId: string;

function withIncompleteAfter(incompleteAfter: number): IncompleteGenerationSweeper {
  return new IncompleteGenerationSweeper({ metering: { incompleteAfter } } as RouterConfig, fixture.dataSource);
}

/** One row in whichever phase the test needs it. */
async function generation(options: { status: GenerationStatus; ageMs: number; costMicros?: number }): Promise<string> {
  const id = `gen-${randomUUID()}`;
  await fixture.dataSource.getRepository(Generation).save({
    id,
    workspaceId,
    apiKeyId: null,
    modelId: MODEL_ID,
    endpointId,
    externalEndpointId: null,
    evidenceSnapshotId: null,
    evidenceDigest: null,
    promptTokens: 0,
    completionTokens: 0,
    costMicros: options.costMicros ?? 0,
    promptPer1mMicros: 240000,
    completionPer1mMicros: 360000,
    streamed: true,
    status: options.status,
    errorCode: null,
    finishReason: null,
    latencyMs: 0,
    createdAt: new Date(NOW.getTime() - options.ageMs),
  });
  return id;
}

async function statusOf(id: string): Promise<Pick<Generation, 'status' | 'errorCode' | 'costMicros'>> {
  const row = await fixture.dataSource.getRepository(Generation).findOneByOrFail({ id });
  return { status: row.status, errorCode: row.errorCode, costMicros: row.costMicros };
}

beforeEach(async () => {
  fixture = await createSqliteFixture('cr-incomplete-');
  sweeper = withIncompleteAfter(15 * MINUTE);

  workspaceId = randomUUID();
  await fixture.dataSource
    .getRepository(Workspace)
    .save({ id: workspaceId, name: 'w', slug: `w-${workspaceId.slice(0, 8)}`, balanceMicros: 0, createdAt: NOW });

  endpointId = randomUUID();
  await fixture.dataSource.getRepository(Endpoint).save({
    id: endpointId,
    name: 'qwen3-coder-next',
    hostname: 'qwen3-coder-next.tee.swarm.cloud',
    evidenceUrl: null,
    enabled: true,
    updatedAt: NOW,
  });
  await fixture.dataSource.getRepository(Model).save({
    id: MODEL_ID,
    name: 'Qwen3 Coder Next (FP8)',
    litellmModel: 'vllm/qwen3-coder-next',
    endpointId,
    contextLength: 262144,
    capabilities: ['chat'],
    promptPer1mMicros: 240000,
    completionPer1mMicros: 360000,
    enabled: true,
    updatedAt: NOW,
  });
});

afterEach(async () => {
  await fixture?.close();
});

describe('IncompleteGenerationSweeper', () => {
  /**
   * SUP-423: the request this is modelled on burned sixty seconds of a paying
   * account's agent time, was answered 502 by something in front of the router,
   * and left nothing in Logs at all. With the row opened at admission it is a
   * `pending` row; this is what closes it.
   */
  it('closes a generation nobody ever finished as no_response', async () => {
    const id = await generation({ status: 'pending', ageMs: 20 * MINUTE });

    expect(await sweeper.sweepOnce(NOW)).toBe(1);
    expect(await statusOf(id)).toEqual({ status: 'error', errorCode: NO_RESPONSE_CODE, costMicros: 0 });
  });

  it('leaves a generation that is still running alone', async () => {
    // A long completion is not a failure. Closing it early would put an error on
    // the screen for a request that is about to succeed, and then overwrite it.
    const id = await generation({ status: 'pending', ageMs: 30 * 1000 });

    expect(await sweeper.sweepOnce(NOW)).toBe(0);
    expect((await statusOf(id)).status).toBe('pending');
  });

  it('never touches a row the gateway already closed', async () => {
    const ok = await generation({ status: 'ok', ageMs: 2 * 60 * MINUTE, costMicros: 3530 });
    const errored = await generation({ status: 'error', ageMs: 2 * 60 * MINUTE });
    const aborted = await generation({ status: 'aborted', ageMs: 2 * 60 * MINUTE });

    expect(await sweeper.sweepOnce(NOW)).toBe(0);
    expect(await statusOf(ok)).toEqual({ status: 'ok', errorCode: null, costMicros: 3530 });
    expect((await statusOf(errored)).status).toBe('error');
    expect((await statusOf(aborted)).status).toBe('aborted');
  });

  it('charges nothing for what it closes', async () => {
    // The row carries whatever the admission wrote, and admission writes zero.
    // A swept generation produced no tokens the workspace could owe for.
    const id = await generation({ status: 'pending', ageMs: 20 * MINUTE });

    await sweeper.sweepOnce(NOW);

    expect((await statusOf(id)).costMicros).toBe(0);
  });

  it('is a no-op when the sweep is disabled', async () => {
    const id = await generation({ status: 'pending', ageMs: 10 * 60 * MINUTE });
    const disabled = withIncompleteAfter(0);
    disabled.onApplicationBootstrap();

    expect((await statusOf(id)).status).toBe('pending');
  });

  it('sweeps every overdue row in one pass, whoever owns them', async () => {
    const overdue = [
      await generation({ status: 'pending', ageMs: 16 * MINUTE }),
      await generation({ status: 'pending', ageMs: 40 * MINUTE }),
    ];
    await generation({ status: 'pending', ageMs: MINUTE });

    expect(await sweeper.sweepOnce(NOW)).toBe(2);
    for (const id of overdue) {
      expect((await statusOf(id)).errorCode).toBe(NO_RESPONSE_CODE);
    }
  });

  it('is idempotent, so concurrent replicas cannot double-close a row', async () => {
    await generation({ status: 'pending', ageMs: 20 * MINUTE });

    expect(await sweeper.sweepOnce(NOW)).toBe(1);
    expect(await sweeper.sweepOnce(NOW)).toBe(0);
  });
});
