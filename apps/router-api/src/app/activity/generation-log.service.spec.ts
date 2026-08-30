import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Catalog, createTestDataSource, seedCatalog, seedGeneration } from '../../../test/seed.js';
import { GenerationLogService } from './generation-log.service.js';

let dataSource: DataSource;
let logs: GenerationLogService;
let catalog: Catalog;

beforeEach(async () => {
  dataSource = await createTestDataSource();
  logs = new GenerationLogService(dataSource);
  catalog = await seedCatalog(dataSource);
});

afterEach(async () => {
  await dataSource.destroy();
});

/** `count` generations one minute apart, oldest first, with ascending cost. */
async function seedSeries(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await seedGeneration(dataSource, catalog, {
      createdAt: new Date(Date.UTC(2026, 7, 28, 9, index)),
      costMicros: (index + 1) * 100,
      latencyMs: 1_000 - index,
      promptTokens: index,
      completionTokens: index,
    });
  }
}

describe('paging', () => {
  it('returns the newest first and reports the total', async () => {
    await seedSeries(5);

    const page = await logs.page({ workspaceId: catalog.workspaceId, first: 2 });

    expect(page.totalCount).toBe(5);
    expect(page.hasNextPage).toBe(true);
    expect(page.edges.map((edge) => edge.node.generation.costMicros)).toEqual([500, 400]);
  });

  it('walks the whole log without repeating or skipping a row', async () => {
    await seedSeries(7);

    const seen: string[] = [];
    let after: string | null = null;
    for (let request = 0; request < 4; request += 1) {
      const page = await logs.page({ workspaceId: catalog.workspaceId, first: 2, after });
      seen.push(...page.edges.map((edge) => edge.node.generation.id));
      after = page.endCursor;
      if (!page.hasNextPage) {
        break;
      }
    }

    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });

  it('keeps a page boundary stable when rows are appended behind the cursor', async () => {
    await seedSeries(4);
    const first = await logs.page({ workspaceId: catalog.workspaceId, first: 2 });

    // A newer generation lands between the two requests. With an offset it would
    // shift the window and repeat a row; with a keyset cursor it cannot.
    await seedGeneration(dataSource, catalog, { createdAt: new Date(Date.UTC(2026, 7, 28, 10)), costMicros: 999 });
    const second = await logs.page({ workspaceId: catalog.workspaceId, first: 2, after: first.endCursor });

    const overlap = second.edges.filter((edge) =>
      first.edges.some((earlier) => earlier.node.generation.id === edge.node.generation.id),
    );
    expect(overlap).toEqual([]);
  });

  it('caps an oversized page request', async () => {
    await seedSeries(3);

    expect((await logs.page({ workspaceId: catalog.workspaceId, first: 10_000 })).edges).toHaveLength(3);
  });
});

describe('sorting', () => {
  it('sorts by cost', async () => {
    await seedSeries(3);

    const page = await logs.page({
      workspaceId: catalog.workspaceId,
      sort: { field: 'costMicros', direction: 'ASC' },
      first: 3,
    });

    expect(page.edges.map((edge) => edge.node.generation.costMicros)).toEqual([100, 200, 300]);
  });

  it('sorts by total tokens, which is not a column', async () => {
    await seedSeries(3);

    const page = await logs.page({
      workspaceId: catalog.workspaceId,
      sort: { field: 'totalTokens', direction: 'DESC' },
      first: 3,
    });

    expect(page.edges.map((edge) => edge.node.generation.promptTokens + edge.node.generation.completionTokens)).toEqual(
      [4, 2, 0],
    );
  });

  it('pages correctly under a non-default sort', async () => {
    await seedSeries(5);
    const sort = { field: 'latencyMs', direction: 'ASC' } as const;

    const first = await logs.page({ workspaceId: catalog.workspaceId, sort, first: 2 });
    const second = await logs.page({ workspaceId: catalog.workspaceId, sort, first: 3, after: first.endCursor });

    expect([...first.edges, ...second.edges].map((edge) => edge.node.generation.latencyMs)).toEqual([
      996, 997, 998, 999, 1_000,
    ]);
  });
});

describe('filtering', () => {
  it('narrows by range, model, key and status', async () => {
    await seedGeneration(dataSource, catalog, { createdAt: new Date('2026-08-28T09:00:00Z'), status: 'ok' });
    await seedGeneration(dataSource, catalog, { createdAt: new Date('2026-08-29T09:00:00Z'), status: 'error' });
    await seedGeneration(dataSource, catalog, {
      createdAt: new Date('2026-08-29T10:00:00Z'),
      status: 'ok',
      apiKeyId: null,
    });

    const byStatus = await logs.page({ workspaceId: catalog.workspaceId, filter: { statuses: ['error'] } });
    const byKey = await logs.page({ workspaceId: catalog.workspaceId, filter: { apiKeyIds: [catalog.apiKeyId] } });
    const byRange = await logs.page({
      workspaceId: catalog.workspaceId,
      filter: { from: new Date('2026-08-29T00:00:00Z'), to: new Date('2026-08-30T00:00:00Z') },
    });
    const byModel = await logs.page({ workspaceId: catalog.workspaceId, filter: { modelIds: ['nothing/here'] } });

    expect(byStatus.totalCount).toBe(1);
    expect(byKey.totalCount).toBe(2);
    expect(byRange.totalCount).toBe(2);
    expect(byModel.totalCount).toBe(0);
  });

  it('never leaks another workspace', async () => {
    const other = await seedCatalog(dataSource);
    await seedGeneration(dataSource, other, { createdAt: new Date('2026-08-28T09:00:00Z') });

    expect((await logs.page({ workspaceId: catalog.workspaceId })).totalCount).toBe(0);
  });
});

describe('resolved names', () => {
  it('shows the model and key names, and survives a deleted key', async () => {
    await seedGeneration(dataSource, catalog, { createdAt: new Date('2026-08-28T09:00:00Z') });
    await seedGeneration(dataSource, catalog, { createdAt: new Date('2026-08-28T10:00:00Z'), apiKeyId: null });

    const page = await logs.page({ workspaceId: catalog.workspaceId });

    expect(page.edges.map((edge) => edge.node.apiKeyName)).toEqual([null, 'Production']);
    expect(page.edges[0].node.modelName).toBe('Llama 3.3 70B Instruct');
  });
});

describe('the CSV export', () => {
  it('yields every matching row, oldest first, in chunks', async () => {
    await seedSeries(6);

    const rows = [];
    for await (const chunk of logs.exportCsv({ workspaceId: catalog.workspaceId })) {
      rows.push(...chunk);
    }

    expect(rows).toHaveLength(6);
    expect(rows.map((row) => row.costMicros)).toEqual([100, 200, 300, 400, 500, 600]);
  });

  it('yields nothing at all for an empty result', async () => {
    const chunks = [];
    for await (const chunk of logs.exportCsv({ workspaceId: catalog.workspaceId })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([]);
  });
});
