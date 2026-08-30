import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In, type SelectQueryBuilder } from 'typeorm';
import { type Cursor, decodeCursor, encodeCursor } from '../common/cursor.js';
import { ApiKey } from '../db/entities/api-key.entity.js';
import { Generation, type GenerationStatus } from '../db/entities/generation.entity.js';
import { Model } from '../db/entities/model.entity.js';

export type GenerationSortField = 'createdAt' | 'costMicros' | 'latencyMs' | 'totalTokens';
export type SortDirection = 'ASC' | 'DESC';

export interface GenerationFilter {
  from?: Date | null;
  to?: Date | null;
  modelIds?: string[] | null;
  apiKeyIds?: string[] | null;
  statuses?: GenerationStatus[] | null;
}

export interface GenerationSort {
  field: GenerationSortField;
  direction: SortDirection;
}

export interface GenerationLogQuery {
  workspaceId: string;
  filter?: GenerationFilter | null;
  sort?: GenerationSort | null;
  first?: number | null;
  after?: string | null;
}

/** A log row with the two names the console shows resolved. */
export interface GenerationRow {
  generation: Generation;
  modelName: string;
  apiKeyName: string | null;
}

export interface GenerationPage {
  edges: Array<{ cursor: string; node: GenerationRow }>;
  hasNextPage: boolean;
  endCursor: string | null;
  totalCount: number;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/** How many rows the CSV export pulls per round-trip. */
const EXPORT_CHUNK = 500;

/** SQL for each sortable field. `totalTokens` is computed, and sorts as computed. */
const SORT_EXPRESSIONS: Record<GenerationSortField, string> = {
  createdAt: 'generation.createdAt',
  costMicros: 'generation.costMicros',
  latencyMs: 'generation.latencyMs',
  totalTokens: '(generation.promptTokens + generation.completionTokens)',
};

/**
 * The Logs screen: a filtered, sorted, cursor-paginated view of `generations`,
 * and the CSV of the same query.
 *
 * Model and key names are resolved in two batched lookups rather than a join, so
 * the page query stays a plain range scan on
 * `IDX_generations_workspaceId_createdAt` and a generation whose key was deleted
 * still lists.
 */
@Injectable()
export class GenerationLogService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async page(query: GenerationLogQuery): Promise<GenerationPage> {
    const sort = query.sort ?? { field: 'createdAt', direction: 'DESC' };
    const size = Math.min(Math.max(query.first ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);

    const totalCount = await this.scope(query.workspaceId, query.filter).getCount();

    const rows = await this.sorted(this.scope(query.workspaceId, query.filter), sort, query.after)
      // One more than asked for: whether it exists is `hasNextPage`, and it
      // costs one row rather than a second count.
      .take(size + 1)
      .getMany();

    const hasNextPage = rows.length > size;
    const page = hasNextPage ? rows.slice(0, size) : rows;
    const resolved = await this.resolveNames(page);

    const edges = page.map((generation, index) => ({
      cursor: encodeCursor({ value: sortValueOf(generation, sort.field), id: generation.id }),
      node: resolved[index],
    }));
    return { edges, hasNextPage, endCursor: edges.at(-1)?.cursor ?? null, totalCount };
  }

  /**
   * Streams the whole filtered result as CSV, oldest first.
   *
   * Chunked with a keyset cursor rather than materialised: an export is the one
   * place a workspace legitimately asks for every row it has, and holding a year
   * of generations in memory to answer would be a way to take the process down.
   */
  async *exportCsv(query: Omit<GenerationLogQuery, 'first' | 'after'>): AsyncGenerator<Generation[]> {
    const sort: GenerationSort = { field: 'createdAt', direction: 'ASC' };
    let after: string | null = null;

    for (;;) {
      const rows: Generation[] = await this.sorted(this.scope(query.workspaceId, query.filter), sort, after)
        .take(EXPORT_CHUNK)
        .getMany();
      if (rows.length === 0) {
        return;
      }
      yield rows;
      if (rows.length < EXPORT_CHUNK) {
        return;
      }
      const last = rows[rows.length - 1];
      after = encodeCursor({ value: sortValueOf(last, sort.field), id: last.id });
    }
  }

  /** Model and API key names for a page, in two queries regardless of page size. */
  async resolveNames(generations: Generation[]): Promise<GenerationRow[]> {
    const modelIds = [...new Set(generations.map((generation) => generation.modelId))];
    const apiKeyIds = [
      ...new Set(generations.flatMap((generation) => (generation.apiKeyId ? [generation.apiKeyId] : []))),
    ];

    const models = modelIds.length
      ? await this.dataSource
          .getRepository(Model)
          .find({ where: { id: In(modelIds) }, select: { id: true, name: true } })
      : [];
    const apiKeys = apiKeyIds.length
      ? await this.dataSource
          .getRepository(ApiKey)
          .find({ where: { id: In(apiKeyIds) }, select: { id: true, name: true } })
      : [];

    const modelNames = new Map(models.map((model) => [model.id, model.name]));
    const apiKeyNames = new Map(apiKeys.map((apiKey) => [apiKey.id, apiKey.name]));

    return generations.map((generation) => ({
      generation,
      modelName: modelNames.get(generation.modelId) ?? generation.modelId,
      apiKeyName: generation.apiKeyId ? (apiKeyNames.get(generation.apiKeyId) ?? null) : null,
    }));
  }

  private scope(workspaceId: string, filter?: GenerationFilter | null): SelectQueryBuilder<Generation> {
    const query = this.dataSource
      .getRepository(Generation)
      .createQueryBuilder('generation')
      .where('generation.workspaceId = :workspaceId', { workspaceId });

    if (filter?.from) {
      query.andWhere('generation.createdAt >= :from', { from: filter.from.getTime() });
    }
    if (filter?.to) {
      query.andWhere('generation.createdAt < :to', { to: filter.to.getTime() });
    }
    if (filter?.modelIds?.length) {
      query.andWhere('generation.modelId IN (:...modelIds)', { modelIds: filter.modelIds });
    }
    if (filter?.apiKeyIds?.length) {
      query.andWhere('generation.apiKeyId IN (:...apiKeyIds)', { apiKeyIds: filter.apiKeyIds });
    }
    if (filter?.statuses?.length) {
      query.andWhere('generation.status IN (:...statuses)', { statuses: filter.statuses });
    }
    return query;
  }

  /**
   * Applies the sort and, when paging, the keyset predicate.
   *
   * The predicate is written out as `field <> :value OR (field = :value AND id
   * <> :id)` rather than as a row-value comparison, which SQLite and PostgreSQL
   * do not support identically.
   */
  private sorted(
    query: SelectQueryBuilder<Generation>,
    sort: GenerationSort,
    after: string | null | undefined,
  ): SelectQueryBuilder<Generation> {
    const expression = SORT_EXPRESSIONS[sort.field];
    const comparison = sort.direction === 'DESC' ? '<' : '>';

    if (after) {
      const cursor: Cursor = decodeCursor(after);
      query.andWhere(
        `(${expression} ${comparison} :cursorValue OR (${expression} = :cursorValue AND generation.id ${comparison} :cursorId))`,
        { cursorValue: cursor.value, cursorId: cursor.id },
      );
    }
    return query.orderBy(expression, sort.direction).addOrderBy('generation.id', sort.direction);
  }
}

export function sortValueOf(generation: Generation, field: GenerationSortField): number {
  switch (field) {
    case 'createdAt':
      return generation.createdAt.getTime();
    case 'costMicros':
      return generation.costMicros;
    case 'latencyMs':
      return generation.latencyMs;
    case 'totalTokens':
      return generation.promptTokens + generation.completionTokens;
  }
}
