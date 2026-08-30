import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type SelectQueryBuilder } from 'typeorm';
import { ApiKey } from '../db/entities/api-key.entity.js';
import { Generation } from '../db/entities/generation.entity.js';
import { Model } from '../db/entities/model.entity.js';
import { average, BUCKET_MS, type BucketSize, bucketStarts, coverage, toNumber } from './buckets.js';

export interface ActivityRange {
  workspaceId: string;
  from: Date;
  to: Date;
}

export interface ActivityTotals {
  requests: number;
  coveredRequests: number;
  promptTokens: number;
  completionTokens: number;
  spendMicros: number;
  evidenceCoverage: number;
}

export interface ActivitySummary extends ActivityTotals {
  avgTimeToFirstTokenMs: number | null;
  avgTokensPerSecond: number | null;
}

export interface ActivityPoint extends ActivityTotals {
  bucket: Date;
}

export interface KeyUsage extends ActivityTotals {
  apiKeyId: string | null;
  name: string;
  prefix: string | null;
}

export interface ModelUsage extends ActivityTotals {
  modelId: string;
  name: string;
}

/** Longest window the console may aggregate in one query. */
const MAX_RANGE_DAYS = 400;

/**
 * The Activity, Overview and Profile screens' numbers, aggregated in SQL over
 * `generations`.
 *
 * There is deliberately no rollup table in the read path. `activity_rollups`
 * exists in the schema for the day the generation table is too large to scan,
 * but a cache that nothing writes is worse than no cache, and a cache that two
 * screens disagree with is worse still: while one indexed range scan answers in
 * milliseconds, one source of truth is the cheaper property to keep. The index
 * that makes it work is `IDX_generations_workspaceId_createdAt`, and every query
 * here is a prefix of it.
 *
 * Bucket sizes are inlined into the SQL rather than bound as parameters. They
 * come from a closed set of constants, never from the caller, and inlining keeps
 * integer division integer on both drivers instead of depending on how each one
 * infers a parameter's type.
 */
@Injectable()
export class ActivityService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async summary(range: ActivityRange): Promise<ActivitySummary> {
    const row = await this.scope(range)
      .select(TOTALS_SELECTS.map((select) => select.expression).join(', '))
      .addSelect(
        'SUM(CASE WHEN generation.timeToFirstTokenMs IS NULL THEN 0 ELSE generation.timeToFirstTokenMs END)',
        'ttftSum',
      )
      .addSelect('COUNT(generation.timeToFirstTokenMs)', 'ttftSamples')
      .addSelect(
        'SUM(CASE WHEN generation.tokensPerSecond IS NULL THEN 0 ELSE generation.tokensPerSecond END)',
        'tpsSum',
      )
      .addSelect('COUNT(generation.tokensPerSecond)', 'tpsSamples')
      .getRawOne<Record<string, unknown>>();

    return {
      ...totalsOf(row ?? {}),
      avgTimeToFirstTokenMs: average(row?.ttftSum, row?.ttftSamples),
      avgTokensPerSecond: average(row?.tpsSum, row?.tpsSamples),
    };
  }

  /** Zero-filled: a bucket with no traffic is a point at zero, never a hole. */
  async series(range: ActivityRange, size: BucketSize): Promise<ActivityPoint[]> {
    const bucket = bucketExpression(size);
    const rows = await this.scope(range)
      .select(`${bucket}`, 'bucket')
      .addSelect(TOTALS_SELECTS.map((select) => select.expression).join(', '))
      .groupBy(bucket)
      .getRawMany<Record<string, unknown>>();

    const byBucket = new Map(rows.map((row) => [toNumber(row.bucket), totalsOf(row)]));
    return bucketStarts(range.from, range.to, size).map((start) => ({
      bucket: new Date(start),
      ...(byBucket.get(start) ?? EMPTY_TOTALS),
    }));
  }

  /** Top API keys by spend. A generation whose key was deleted groups under "Deleted key". */
  async topKeys(range: ActivityRange, limit = 5): Promise<KeyUsage[]> {
    const rows = await this.scope(range)
      .leftJoin(ApiKey, 'apiKey', 'apiKey.id = generation.apiKeyId')
      .select('generation.apiKeyId', 'apiKeyId')
      .addSelect('apiKey.name', 'name')
      .addSelect('apiKey.prefix', 'prefix')
      .addSelect(TOTALS_SELECTS.map((select) => select.expression).join(', '))
      .groupBy('generation.apiKeyId')
      .addGroupBy('apiKey.name')
      .addGroupBy('apiKey.prefix')
      .orderBy('"spendMicros"', 'DESC')
      .limit(limit)
      .getRawMany<Record<string, unknown>>();

    return rows.map((row) => ({
      apiKeyId: (row.apiKeyId as string | null) ?? null,
      name: (row.name as string | null) ?? 'Deleted key',
      prefix: (row.prefix as string | null) ?? null,
      ...totalsOf(row),
    }));
  }

  /** Usage per model, most expensive first — also the "top models by spend" list. */
  async usageByModel(range: ActivityRange, limit?: number): Promise<ModelUsage[]> {
    const query = this.scope(range)
      .leftJoin(Model, 'model', 'model.id = generation.modelId')
      .select('generation.modelId', 'modelId')
      .addSelect('model.name', 'name')
      .addSelect(TOTALS_SELECTS.map((select) => select.expression).join(', '))
      .groupBy('generation.modelId')
      .addGroupBy('model.name')
      .orderBy('"spendMicros"', 'DESC');
    if (limit !== undefined) {
      query.limit(limit);
    }
    const rows = await query.getRawMany<Record<string, unknown>>();

    return rows.map((row) => ({
      modelId: String(row.modelId),
      name: (row.name as string | null) ?? String(row.modelId),
      ...totalsOf(row),
    }));
  }

  /**
   * The Profile heatmap: every UTC day in the window on which at least one
   * generation was served while the endpoint had published evidence.
   *
   * "Signed response" here means the router had a published bundle for that
   * generation — a fact about publication, never a verdict about validity
   * (ADR-002).
   */
  async signedResponseDays(workspaceId: string, days: number, now = new Date()): Promise<Date[]> {
    const to = new Date(now.getTime());
    const from = new Date(to.getTime() - days * BUCKET_MS.day);
    const bucket = bucketExpression('day');

    const rows = await this.scope({ workspaceId, from, to })
      .andWhere('generation.evidenceSnapshotId IS NOT NULL')
      .select(bucket, 'bucket')
      .distinct(true)
      .orderBy(bucket, 'ASC')
      .getRawMany<{ bucket: unknown }>();

    return rows.map((row) => new Date(toNumber(row.bucket)));
  }

  private scope(range: ActivityRange): SelectQueryBuilder<Generation> {
    if (range.to.getTime() <= range.from.getTime()) {
      throw new BadRequestException('The end of the range must be after its start.');
    }
    if (range.to.getTime() - range.from.getTime() > MAX_RANGE_DAYS * BUCKET_MS.day) {
      throw new BadRequestException(`A range may cover at most ${MAX_RANGE_DAYS} days.`);
    }
    return this.dataSource
      .getRepository(Generation)
      .createQueryBuilder('generation')
      .where('generation.workspaceId = :workspaceId', { workspaceId: range.workspaceId })
      .andWhere('generation.createdAt >= :from', { from: range.from.getTime() })
      .andWhere('generation.createdAt < :to', { to: range.to.getTime() });
  }
}

/** The one aggregate list every activity query shares, so they cannot drift apart. */
const TOTALS_SELECTS = [
  { alias: 'requests', expression: 'COUNT(*) AS "requests"' },
  {
    alias: 'coveredRequests',
    expression: 'SUM(CASE WHEN generation.evidenceSnapshotId IS NULL THEN 0 ELSE 1 END) AS "coveredRequests"',
  },
  { alias: 'promptTokens', expression: 'SUM(generation.promptTokens) AS "promptTokens"' },
  { alias: 'completionTokens', expression: 'SUM(generation.completionTokens) AS "completionTokens"' },
  { alias: 'spendMicros', expression: 'SUM(generation.costMicros) AS "spendMicros"' },
] as const;

const EMPTY_TOTALS: ActivityTotals = {
  requests: 0,
  coveredRequests: 0,
  promptTokens: 0,
  completionTokens: 0,
  spendMicros: 0,
  evidenceCoverage: 0,
};

function totalsOf(row: Record<string, unknown>): ActivityTotals {
  return {
    requests: toNumber(row.requests),
    coveredRequests: toNumber(row.coveredRequests),
    promptTokens: toNumber(row.promptTokens),
    completionTokens: toNumber(row.completionTokens),
    spendMicros: toNumber(row.spendMicros),
    evidenceCoverage: coverage(row.coveredRequests, row.requests),
  };
}

/** Truncates `createdAt` to the start of its bucket. See the class comment on inlining. */
function bucketExpression(size: BucketSize): string {
  const step = BUCKET_MS[size];
  return `((generation.createdAt / ${step}) * ${step})`;
}
