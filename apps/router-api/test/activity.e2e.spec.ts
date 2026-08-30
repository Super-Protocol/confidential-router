import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './app-harness.js';
import { type ConsoleSession, dataSourceOf, expectData, graphql, signIn } from './console.js';
import { type Catalog, seedCatalog, seedGeneration } from './seed.js';

/**
 * The Activity and Logs screens against the real module graph: the same guards,
 * the same resolvers and the same SQL a deployment runs.
 */

const FROM = '2026-08-28T00:00:00.000Z';
const TO = '2026-08-31T00:00:00.000Z';

const SUMMARY = `
  query Summary($workspaceId: ID!, $from: DateTime!, $to: DateTime!) {
    activitySummary(workspaceId: $workspaceId, from: $from, to: $to) {
      requests coveredRequests promptTokens completionTokens spendMicros evidenceCoverage
      avgTimeToFirstTokenMs avgTokensPerSecond
    }
  }
`;

const SERIES = `
  query Series($workspaceId: ID!, $from: DateTime!, $to: DateTime!, $bucket: Bucket!) {
    activitySeries(workspaceId: $workspaceId, from: $from, to: $to, bucket: $bucket) {
      bucket requests spendMicros evidenceCoverage
    }
  }
`;

const TOP_KEYS = `
  query TopKeys($workspaceId: ID!, $from: DateTime!, $to: DateTime!, $limit: Int!) {
    topKeys(workspaceId: $workspaceId, from: $from, to: $to, limit: $limit) { apiKeyId name prefix spendMicros }
  }
`;

const USAGE_BY_MODEL = `
  query UsageByModel($workspaceId: ID!, $from: DateTime!, $to: DateTime!, $limit: Int) {
    usageByModel(workspaceId: $workspaceId, from: $from, to: $to, limit: $limit) { modelId name spendMicros requests }
  }
`;

const SIGNED_DAYS = `
  query SignedDays($workspaceId: ID!, $days: Int!) {
    signedResponseDays(workspaceId: $workspaceId, days: $days)
  }
`;

const GENERATIONS = `
  query Generations($workspaceId: ID!, $filter: GenerationFilter, $sort: GenerationSort, $first: Int!, $after: String) {
    generations(workspaceId: $workspaceId, filter: $filter, sort: $sort, first: $first, after: $after) {
      totalCount
      pageInfo { hasNextPage endCursor }
      edges { node { id modelId modelName apiKeyName costMicros status evidenceDigest promptTokens } }
    }
  }
`;

let harness: Harness;
let session: ConsoleSession;
let catalog: Catalog;

beforeAll(async () => {
  harness = await createHarness();
  session = await signIn(harness, 'activity@example.com');

  const dataSource = dataSourceOf(harness);
  // The workspace already exists — it was provisioned at sign-in — so only the
  // catalogue rows a generation points at have to be seeded.
  catalog = { ...(await seedCatalog(dataSource)), workspaceId: session.workspaceId };

  await seedGeneration(dataSource, catalog, {
    createdAt: new Date('2026-08-28T09:00:00Z'),
    costMicros: 5_450,
    promptTokens: 5_454,
    completionTokens: 362,
    timeToFirstTokenMs: 100,
    covered: true,
  });
  await seedGeneration(dataSource, catalog, {
    createdAt: new Date('2026-08-28T15:00:00Z'),
    costMicros: 1_200,
    promptTokens: 100,
    completionTokens: 40,
    timeToFirstTokenMs: 300,
    covered: false,
  });
  await seedGeneration(dataSource, catalog, {
    createdAt: new Date('2026-08-30T11:00:00Z'),
    costMicros: 700,
    promptTokens: 10,
    completionTokens: 5,
    status: 'error',
    apiKeyId: null,
    covered: true,
    // An errored generation that never produced a token: it counts towards
    // requests and spend, and towards no latency average.
    timeToFirstTokenMs: null,
    tokensPerSecond: null,
  });
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

const range = () => ({ workspaceId: session.workspaceId, from: FROM, to: TO });

describe('activitySummary', () => {
  it('reports spend, tokens, coverage and latency for the period', async () => {
    const data = await expectData(session, SUMMARY, range());

    expect(data.activitySummary).toEqual({
      requests: 3,
      coveredRequests: 2,
      promptTokens: 5_564,
      completionTokens: 407,
      spendMicros: '7350',
      evidenceCoverage: 2 / 3,
      avgTimeToFirstTokenMs: 200,
      avgTokensPerSecond: 42,
    });
  });
});

describe('activitySeries', () => {
  it('returns one point per UTC day, zeroes included', async () => {
    const data = await expectData(session, SERIES, { ...range(), bucket: 'DAY' });

    expect(data.activitySeries).toEqual([
      expect.objectContaining({ bucket: '2026-08-28T00:00:00.000Z', requests: 2, spendMicros: '6650' }),
      expect.objectContaining({ bucket: '2026-08-29T00:00:00.000Z', requests: 0, spendMicros: '0' }),
      expect.objectContaining({ bucket: '2026-08-30T00:00:00.000Z', requests: 1, spendMicros: '700' }),
    ]);
  });

  it('returns one point per UTC hour when asked', async () => {
    const data = await expectData(session, SERIES, {
      workspaceId: session.workspaceId,
      from: '2026-08-28T09:00:00.000Z',
      to: '2026-08-28T12:00:00.000Z',
      bucket: 'HOUR',
    });

    expect(data.activitySeries).toHaveLength(3);
    expect(data.activitySeries[0]).toMatchObject({ requests: 1, evidenceCoverage: 1 });
  });
});

describe('topKeys and usageByModel', () => {
  it('names the key, and keeps spend whose key is gone', async () => {
    const data = await expectData(session, TOP_KEYS, { ...range(), limit: 5 });

    expect(data.topKeys).toEqual([
      expect.objectContaining({ name: 'Production', spendMicros: '6650' }),
      expect.objectContaining({ apiKeyId: null, name: 'Deleted key', spendMicros: '700' }),
    ]);
  });

  it('lists models by spend, and narrows to the top when limited', async () => {
    const all = await expectData(session, USAGE_BY_MODEL, { ...range(), limit: null });
    const top = await expectData(session, USAGE_BY_MODEL, { ...range(), limit: 1 });

    expect(all.usageByModel[0]).toMatchObject({ name: 'Llama 3.3 70B Instruct', requests: 3, spendMicros: '7350' });
    expect(top.usageByModel).toHaveLength(1);
  });
});

describe('signedResponseDays', () => {
  it('lists the UTC days with at least one generation served under published evidence', async () => {
    const data = await expectData(session, SIGNED_DAYS, { workspaceId: session.workspaceId, days: 400 });

    expect(data.signedResponseDays).toEqual(['2026-08-28T00:00:00.000Z', '2026-08-30T00:00:00.000Z']);
  });
});

describe('the generation log', () => {
  it('lists newest first with names resolved', async () => {
    const data = await expectData(session, GENERATIONS, { workspaceId: session.workspaceId, first: 10 });

    expect(data.generations.totalCount).toBe(3);
    expect(data.generations.edges[0].node).toMatchObject({
      status: 'ERROR',
      apiKeyName: null,
      modelName: 'Llama 3.3 70B Instruct',
      costMicros: '700',
    });
  });

  it('never records prompt or completion content', async () => {
    const data = await expectData(session, GENERATIONS, { workspaceId: session.workspaceId, first: 10 });

    // The schema has no field that could carry it; this asserts the shipped
    // response as well (`docs/threat-model.md`).
    for (const edge of data.generations.edges) {
      expect(Object.keys(edge.node)).not.toContain('messages');
      expect(Object.keys(edge.node)).not.toContain('content');
    }
  });

  it('pages with a stable cursor', async () => {
    const first = await expectData(session, GENERATIONS, { workspaceId: session.workspaceId, first: 2 });
    const second = await expectData(session, GENERATIONS, {
      workspaceId: session.workspaceId,
      first: 2,
      after: first.generations.pageInfo.endCursor,
    });

    expect(first.generations.pageInfo.hasNextPage).toBe(true);
    expect(second.generations.edges).toHaveLength(1);
    expect(second.generations.pageInfo.hasNextPage).toBe(false);
  });

  it('filters by status and sorts by cost', async () => {
    const data = await expectData(session, GENERATIONS, {
      workspaceId: session.workspaceId,
      filter: { statuses: ['OK'] },
      sort: { field: 'COST', direction: 'ASC' },
      first: 10,
    });

    expect(data.generations.edges.map((edge: { node: { costMicros: string } }) => edge.node.costMicros)).toEqual([
      '1200',
      '5450',
    ]);
  });

  it('rejects a page size beyond the cap instead of silently truncating', async () => {
    const body = await graphql(session, GENERATIONS, {
      workspaceId: session.workspaceId,
      first: 5_000,
    });

    expect(body.errors).toBeDefined();
  });
});

describe('the CSV export', () => {
  function csv(query: string) {
    return request(harness.app.getHttpServer())
      .get(`/activity/generations.csv?${query}`)
      .set('Cookie', session.cookies);
  }

  it('downloads every row, oldest first, with a header', async () => {
    const response = await csv(`workspaceId=${session.workspaceId}`).expect(200);

    expect(response.headers['content-type']).toMatch(/text\/csv/);
    expect(response.headers['content-disposition']).toMatch(/attachment; filename=/);
    const lines = response.text.trim().split('\r\n');
    expect(lines[0]).toContain('id,createdAt,modelId');
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain('2026-08-28T09:00:00.000Z');
  });

  it('honours the same filters as the log', async () => {
    const response = await csv(`workspaceId=${session.workspaceId}&status=error`).expect(200);

    expect(response.text.trim().split('\r\n')).toHaveLength(2);
  });

  it('carries no prompt or completion column', async () => {
    const response = await csv(`workspaceId=${session.workspaceId}`).expect(200);
    const header = response.text.split('\r\n')[0];

    for (const column of ['prompt,', 'messages', 'content', 'completion,']) {
      expect(header).not.toContain(column);
    }
  });

  it('refuses an anonymous download', async () => {
    await request(harness.app.getHttpServer())
      .get(`/activity/generations.csv?workspaceId=${session.workspaceId}`)
      .expect(401);
  });

  it("refuses another member's workspace", async () => {
    const other = await signIn(harness, 'csv-stranger@example.com');

    await request(harness.app.getHttpServer())
      .get(`/activity/generations.csv?workspaceId=${session.workspaceId}`)
      .set('Cookie', other.cookies)
      .expect(403);
  });

  it('rejects an unknown query parameter rather than ignoring it', async () => {
    await csv(`workspaceId=${session.workspaceId}&sneaky=1`).expect(400);
  });
});
