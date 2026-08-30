import { UseGuards } from '@nestjs/common';
import { Args, GraphQLISODateTime, Query, Resolver } from '@nestjs/graphql';
import type {
  ActivityTotals,
  BucketSize,
  GenerationFilter,
  GenerationRow,
  GenerationSort,
} from '../../../activity/index.js';
import { ActivityService, GenerationLogService } from '../../../activity/index.js';
import { CurrentUser, SessionGuard, type SessionUser, WorkspaceScopeService } from '../../../auth/index.js';
import type { GenerationStatus } from '../../../db/entities/generation.entity.js';
import {
  ActivityRangeArgs,
  ActivitySeriesArgs,
  GenerationsArgs,
  SignedResponseDaysArgs,
  TopKeysArgs,
  UsageByModelArgs,
} from './activity.args.js';
import {
  ActivityPointModel,
  ActivitySummaryModel,
  BucketEnum,
  KeyUsageModel,
  ModelUsageModel,
} from './activity.model.js';
import {
  GenerationConnectionModel,
  GenerationFilterInput,
  type GenerationModel,
  GenerationSortFieldEnum,
  GenerationSortInput,
  GenerationStatusEnum,
  SortDirectionEnum,
} from './generation.model.js';

/**
 * The Activity, Overview, Profile and Logs screens.
 *
 * Every query starts by resolving the caller's membership of the workspace it
 * names, through the one service that enforces tenancy — the ids in these
 * arguments come from the client and are never trusted on their own.
 */
@Resolver()
@UseGuards(SessionGuard)
export class ActivityResolver {
  constructor(
    private readonly activity: ActivityService,
    private readonly logs: GenerationLogService,
    private readonly workspaces: WorkspaceScopeService,
  ) {}

  @Query(() => ActivitySummaryModel, { description: 'Spend, traffic, latency and evidence coverage for a period.' })
  async activitySummary(
    @CurrentUser() user: SessionUser,
    @Args() args: ActivityRangeArgs,
  ): Promise<ActivitySummaryModel> {
    await this.workspaces.requireMembership(user.id, args.workspaceId);
    const summary = await this.activity.summary(args);
    return {
      ...totalsModel(summary),
      avgTimeToFirstTokenMs: summary.avgTimeToFirstTokenMs,
      avgTokensPerSecond: summary.avgTokensPerSecond,
    };
  }

  @Query(() => [ActivityPointModel], { description: 'The same totals, bucketed. Quiet buckets are zeroes.' })
  async activitySeries(
    @CurrentUser() user: SessionUser,
    @Args() args: ActivitySeriesArgs,
  ): Promise<ActivityPointModel[]> {
    await this.workspaces.requireMembership(user.id, args.workspaceId);
    const points = await this.activity.series(args, bucketSizeOf(args.bucket));
    return points.map((point) => ({ bucket: point.bucket, ...totalsModel(point) }));
  }

  @Query(() => [KeyUsageModel], { description: 'API keys by spend, highest first.' })
  async topKeys(@CurrentUser() user: SessionUser, @Args() args: TopKeysArgs): Promise<KeyUsageModel[]> {
    await this.workspaces.requireMembership(user.id, args.workspaceId);
    const rows = await this.activity.topKeys(args, args.limit);
    return rows.map((row) => ({ apiKeyId: row.apiKeyId, name: row.name, prefix: row.prefix, ...totalsModel(row) }));
  }

  @Query(() => [ModelUsageModel], { description: 'Models by spend, highest first.' })
  async usageByModel(@CurrentUser() user: SessionUser, @Args() args: UsageByModelArgs): Promise<ModelUsageModel[]> {
    await this.workspaces.requireMembership(user.id, args.workspaceId);
    const rows = await this.activity.usageByModel(args, args.limit);
    return rows.map((row) => ({ modelId: row.modelId, name: row.name, ...totalsModel(row) }));
  }

  @Query(() => [GraphQLISODateTime], {
    description: 'UTC days on which at least one generation was served with published evidence.',
  })
  async signedResponseDays(@CurrentUser() user: SessionUser, @Args() args: SignedResponseDaysArgs): Promise<Date[]> {
    await this.workspaces.requireMembership(user.id, args.workspaceId);
    return this.activity.signedResponseDays(args.workspaceId, args.days);
  }

  @Query(() => GenerationConnectionModel, { description: 'The generation log, filtered, sorted and paginated.' })
  async generations(
    @CurrentUser() user: SessionUser,
    @Args() args: GenerationsArgs,
  ): Promise<GenerationConnectionModel> {
    await this.workspaces.requireMembership(user.id, args.workspaceId);
    const page = await this.logs.page({
      workspaceId: args.workspaceId,
      filter: filterOf(args.filter),
      sort: sortOf(args.sort),
      first: args.first,
      after: args.after ?? null,
    });

    return {
      edges: page.edges.map((edge) => ({ cursor: edge.cursor, node: generationModel(edge.node) })),
      pageInfo: { hasNextPage: page.hasNextPage, endCursor: page.endCursor },
      totalCount: page.totalCount,
    };
  }
}

/**
 * The GraphQL enums carry the domain's own values, but TypeScript keeps enum
 * members and string literals as distinct types. These are the two places that
 * cross the boundary, written out rather than cast so an added member is a
 * compile error and not a runtime surprise.
 */
function bucketSizeOf(bucket: BucketEnum): BucketSize {
  return bucket === BucketEnum.DAY ? 'day' : 'hour';
}

const SORT_FIELDS: Record<GenerationSortFieldEnum, GenerationSort['field']> = {
  [GenerationSortFieldEnum.CREATED_AT]: 'createdAt',
  [GenerationSortFieldEnum.COST]: 'costMicros',
  [GenerationSortFieldEnum.LATENCY]: 'latencyMs',
  [GenerationSortFieldEnum.TOTAL_TOKENS]: 'totalTokens',
};

const STATUSES: Record<GenerationStatusEnum, GenerationStatus> = {
  [GenerationStatusEnum.OK]: 'ok',
  [GenerationStatusEnum.ERROR]: 'error',
  [GenerationStatusEnum.ABORTED]: 'aborted',
};

function sortOf(sort: GenerationSortInput | undefined): GenerationSort {
  if (!sort) {
    return { field: 'createdAt', direction: 'DESC' };
  }
  return {
    field: SORT_FIELDS[sort.field],
    direction: sort.direction === SortDirectionEnum.ASC ? 'ASC' : 'DESC',
  };
}

function filterOf(filter: GenerationFilterInput | undefined): GenerationFilter | null {
  if (!filter) {
    return null;
  }
  return {
    from: filter.from ?? null,
    to: filter.to ?? null,
    modelIds: filter.modelIds ?? null,
    apiKeyIds: filter.apiKeyIds ?? null,
    statuses: filter.statuses?.map((status) => STATUSES[status]) ?? null,
  };
}

function totalsModel(totals: ActivityTotals) {
  return {
    requests: totals.requests,
    coveredRequests: totals.coveredRequests,
    promptTokens: totals.promptTokens,
    completionTokens: totals.completionTokens,
    spendMicros: String(totals.spendMicros),
    evidenceCoverage: totals.evidenceCoverage,
  };
}

const STATUS_MODELS: Record<GenerationStatus, GenerationStatusEnum> = {
  ok: GenerationStatusEnum.OK,
  error: GenerationStatusEnum.ERROR,
  aborted: GenerationStatusEnum.ABORTED,
};

function generationModel(row: GenerationRow): GenerationModel {
  const { generation } = row;
  return {
    id: generation.id,
    createdAt: generation.createdAt,
    modelId: generation.modelId,
    modelName: row.modelName,
    endpointId: generation.endpointId,
    apiKeyId: generation.apiKeyId,
    apiKeyName: row.apiKeyName,
    promptTokens: generation.promptTokens,
    completionTokens: generation.completionTokens,
    costMicros: String(generation.costMicros),
    latencyMs: generation.latencyMs,
    timeToFirstTokenMs: generation.timeToFirstTokenMs,
    tokensPerSecond: generation.tokensPerSecond,
    streamed: generation.streamed,
    status: STATUS_MODELS[generation.status],
    finishReason: generation.finishReason,
    errorCode: generation.errorCode,
    evidenceSnapshotId: generation.evidenceSnapshotId,
    evidenceDigest: generation.evidenceDigest,
  };
}
