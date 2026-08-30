import { BadRequestException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Catalog, createTestDataSource, seedCatalog, seedGeneration } from '../../../test/seed.js';
import { Model } from '../db/entities/model.entity.js';
import { ActivityService } from './activity.service.js';

/**
 * The aggregation math, against the real migrated schema. The numbers are chosen
 * so a wrong `SUM`, a missed `NULL` or a mis-truncated bucket cannot produce them
 * by accident.
 */

const FROM = new Date('2026-08-28T00:00:00Z');
const TO = new Date('2026-08-31T00:00:00Z');

let dataSource: DataSource;
let activity: ActivityService;
let catalog: Catalog;
let range: { workspaceId: string; from: Date; to: Date };

beforeEach(async () => {
  dataSource = await createTestDataSource();
  activity = new ActivityService(dataSource);
  catalog = await seedCatalog(dataSource);
  range = { workspaceId: catalog.workspaceId, from: FROM, to: TO };
});

afterEach(async () => {
  await dataSource.destroy();
});

describe('summary', () => {
  it('sums spend, requests and tokens over the range', async () => {
    await seedGeneration(dataSource, catalog, {
      createdAt: new Date('2026-08-28T09:00:00Z'),
      costMicros: 5_450,
      promptTokens: 5_454,
      completionTokens: 362,
    });
    await seedGeneration(dataSource, catalog, {
      createdAt: new Date('2026-08-29T09:00:00Z'),
      costMicros: 1_200,
      promptTokens: 100,
      completionTokens: 40,
    });

    expect(await activity.summary(range)).toMatchObject({
      requests: 2,
      spendMicros: 6_650,
      promptTokens: 5_554,
      completionTokens: 402,
    });
  });

  it('counts only what falls inside the range, start inclusive and end exclusive', async () => {
    await seedGeneration(dataSource, catalog, { createdAt: new Date('2026-08-27T23:59:59Z'), costMicros: 999 });
    await seedGeneration(dataSource, catalog, { createdAt: FROM, costMicros: 10 });
    await seedGeneration(dataSource, catalog, { createdAt: TO, costMicros: 999 });

    expect(await activity.summary(range)).toMatchObject({ requests: 1, spendMicros: 10 });
  });

  it('reports evidence coverage as the share of requests that had a published snapshot', async () => {
    await seedGeneration(dataSource, catalog, { createdAt: new Date('2026-08-28T09:00:00Z'), covered: true });
    await seedGeneration(dataSource, catalog, { createdAt: new Date('2026-08-28T10:00:00Z'), covered: true });
    await seedGeneration(dataSource, catalog, { createdAt: new Date('2026-08-28T11:00:00Z'), covered: true });
    await seedGeneration(dataSource, catalog, { createdAt: new Date('2026-08-28T12:00:00Z'), covered: false });

    const summary = await activity.summary(range);

    expect(summary.coveredRequests).toBe(3);
    expect(summary.evidenceCoverage).toBe(0.75);
  });

  it('averages first-token time over the requests that reported one, not over all of them', async () => {
    await seedGeneration(dataSource, catalog, { createdAt: new Date('2026-08-28T09:00:00Z'), timeToFirstTokenMs: 100 });
    await seedGeneration(dataSource, catalog, { createdAt: new Date('2026-08-28T10:00:00Z'), timeToFirstTokenMs: 200 });
    await seedGeneration(dataSource, catalog, {
      createdAt: new Date('2026-08-28T11:00:00Z'),
      timeToFirstTokenMs: null,
    });

    expect((await activity.summary(range)).avgTimeToFirstTokenMs).toBe(150);
  });

  it('answers an empty period with zeroes and null averages, not with nulls throughout', async () => {
    expect(await activity.summary(range)).toEqual({
      requests: 0,
      coveredRequests: 0,
      promptTokens: 0,
      completionTokens: 0,
      spendMicros: 0,
      evidenceCoverage: 0,
      avgTimeToFirstTokenMs: null,
      avgTokensPerSecond: null,
    });
  });

  it('counts errored and aborted generations too: they still cost what they cost', async () => {
    await seedGeneration(dataSource, catalog, {
      createdAt: new Date('2026-08-28T09:00:00Z'),
      status: 'error',
      costMicros: 300,
    });

    expect(await activity.summary(range)).toMatchObject({ requests: 1, spendMicros: 300 });
  });

  it('never counts another workspace', async () => {
    const other = await seedCatalog(dataSource);
    await seedGeneration(dataSource, other, { createdAt: new Date('2026-08-28T09:00:00Z'), costMicros: 999_999 });

    expect(await activity.summary(range)).toMatchObject({ requests: 0, spendMicros: 0 });
  });

  it('refuses a range that is backwards or absurdly wide', async () => {
    await expect(activity.summary({ ...range, to: FROM })).rejects.toThrow(BadRequestException);
    await expect(activity.summary({ ...range, to: new Date(FROM.getTime() + 401 * 86_400_000) })).rejects.toThrow(
      BadRequestException,
    );
  });
});

describe('series', () => {
  it('buckets by UTC day and fills quiet days with zeroes', async () => {
    await seedGeneration(dataSource, catalog, { createdAt: new Date('2026-08-28T01:00:00Z'), costMicros: 10 });
    await seedGeneration(dataSource, catalog, { createdAt: new Date('2026-08-28T23:59:00Z'), costMicros: 5 });
    await seedGeneration(dataSource, catalog, { createdAt: new Date('2026-08-30T12:00:00Z'), costMicros: 7 });

    const series = await activity.series(range, 'day');

    expect(series.map((point) => [point.bucket.toISOString(), point.spendMicros, point.requests])).toEqual([
      ['2026-08-28T00:00:00.000Z', 15, 2],
      ['2026-08-29T00:00:00.000Z', 0, 0],
      ['2026-08-30T00:00:00.000Z', 7, 1],
    ]);
  });

  it('buckets by UTC hour', async () => {
    await seedGeneration(dataSource, catalog, { createdAt: new Date('2026-08-28T09:15:00Z'), costMicros: 3 });
    await seedGeneration(dataSource, catalog, { createdAt: new Date('2026-08-28T09:45:00Z'), costMicros: 4 });

    const series = await activity.series(
      { ...range, from: new Date('2026-08-28T09:00:00Z'), to: new Date('2026-08-28T11:00:00Z') },
      'hour',
    );

    expect(series).toHaveLength(2);
    expect(series[0]).toMatchObject({ spendMicros: 7, requests: 2 });
    expect(series[1]).toMatchObject({ spendMicros: 0, requests: 0 });
  });

  it('agrees with the summary over the same range', async () => {
    for (let hour = 0; hour < 12; hour += 1) {
      await seedGeneration(dataSource, catalog, {
        createdAt: new Date(Date.UTC(2026, 7, 28, hour)),
        costMicros: 100 + hour,
        covered: hour % 2 === 0,
      });
    }

    const summary = await activity.summary(range);
    const series = await activity.series(range, 'day');
    const totals = series.reduce(
      (accumulator, point) => ({
        spendMicros: accumulator.spendMicros + point.spendMicros,
        requests: accumulator.requests + point.requests,
        coveredRequests: accumulator.coveredRequests + point.coveredRequests,
      }),
      { spendMicros: 0, requests: 0, coveredRequests: 0 },
    );

    expect(totals).toEqual({
      spendMicros: summary.spendMicros,
      requests: summary.requests,
      coveredRequests: summary.coveredRequests,
    });
  });
});

describe('topKeys', () => {
  it('orders by spend and resolves the key name', async () => {
    const second = await dataSource.getRepository('api_keys').save({
      id: 'key-2',
      workspaceId: catalog.workspaceId,
      name: 'Staging',
      keyHash: 'hash-2',
      prefix: 'sk-tee-v1-aa',
      modelScope: null,
      spentTotalMicros: 0,
      createdAt: new Date(),
    });
    await seedGeneration(dataSource, catalog, { createdAt: new Date('2026-08-28T09:00:00Z'), costMicros: 100 });
    await seedGeneration(dataSource, catalog, {
      createdAt: new Date('2026-08-28T10:00:00Z'),
      costMicros: 900,
      apiKeyId: second.id as string,
    });

    const keys = await activity.topKeys(range, 5);

    expect(keys.map((key) => [key.name, key.spendMicros])).toEqual([
      ['Staging', 900],
      ['Production', 100],
    ]);
  });

  it('still lists spend whose key has been deleted', async () => {
    await seedGeneration(dataSource, catalog, {
      createdAt: new Date('2026-08-28T09:00:00Z'),
      costMicros: 100,
      apiKeyId: null,
    });

    expect(await activity.topKeys(range)).toEqual([
      expect.objectContaining({ apiKeyId: null, name: 'Deleted key', spendMicros: 100 }),
    ]);
  });

  it('honours the limit', async () => {
    await seedGeneration(dataSource, catalog, { createdAt: new Date('2026-08-28T09:00:00Z') });
    await seedGeneration(dataSource, catalog, { createdAt: new Date('2026-08-28T10:00:00Z'), apiKeyId: null });

    expect(await activity.topKeys(range, 1)).toHaveLength(1);
  });
});

describe('usageByModel', () => {
  it('orders by spend and resolves the model name', async () => {
    await dataSource.getRepository(Model).insert({
      id: 'mistral/mixtral-8x7b:tdx',
      name: 'Mixtral 8x7B',
      litellmModel: 'mixtral',
      endpointId: catalog.endpointId,
      contextLength: 32768,
      capabilities: ['chat'],
      promptPer1mMicros: 100_000,
      completionPer1mMicros: 100_000,
      tee: 'Intel TDX',
      enabled: true,
      updatedAt: new Date(),
    });
    await seedGeneration(dataSource, catalog, { createdAt: new Date('2026-08-28T09:00:00Z'), costMicros: 50 });
    await seedGeneration(dataSource, catalog, {
      createdAt: new Date('2026-08-28T10:00:00Z'),
      costMicros: 500,
      modelId: 'mistral/mixtral-8x7b:tdx',
    });

    expect((await activity.usageByModel(range)).map((usage) => [usage.name, usage.spendMicros])).toEqual([
      ['Mixtral 8x7B', 500],
      ['Llama 3.3 70B Instruct', 50],
    ]);
  });

  it('narrows to the top models when a limit is given', async () => {
    await seedGeneration(dataSource, catalog, { createdAt: new Date('2026-08-28T09:00:00Z') });

    expect(await activity.usageByModel(range, 1)).toHaveLength(1);
  });
});

describe('signedResponseDays', () => {
  it('lists each UTC day that had at least one generation with published evidence', async () => {
    const now = new Date('2026-08-30T18:00:00Z');
    await seedGeneration(dataSource, catalog, { createdAt: new Date('2026-08-28T01:00:00Z'), covered: true });
    await seedGeneration(dataSource, catalog, { createdAt: new Date('2026-08-28T20:00:00Z'), covered: true });
    await seedGeneration(dataSource, catalog, { createdAt: new Date('2026-08-29T10:00:00Z'), covered: false });

    const days = await activity.signedResponseDays(catalog.workspaceId, 30, now);

    expect(days.map((day) => day.toISOString())).toEqual(['2026-08-28T00:00:00.000Z']);
  });

  it('looks no further back than it was asked to', async () => {
    const now = new Date('2026-08-30T18:00:00Z');
    await seedGeneration(dataSource, catalog, { createdAt: new Date('2026-06-01T10:00:00Z'), covered: true });

    expect(await activity.signedResponseDays(catalog.workspaceId, 7, now)).toEqual([]);
  });
});
