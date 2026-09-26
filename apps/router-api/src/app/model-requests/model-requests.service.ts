import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, MoreThan } from 'typeorm';
import { routerConfig } from '../config.js';
import { ModelRequest, type ModelRequestSource } from '../db/entities/model-request.entity.js';
import { ModelRequestRateLimitedError } from './model-requests.errors.js';
import { normaliseModelName } from './normalise-model.js';

export interface RecordModelRequestInput {
  userId: string;
  workspaceId: string;
  /** What the requester typed. Stored verbatim as well as normalised. */
  requestedModel: string;
  note: string | null;
  notify: boolean;
  source: ModelRequestSource;
}

/** One row of the admin aggregation: a model, and how much demand there is for it. */
export interface ModelDemand {
  /** The grouping key — see `normaliseModelName`. */
  normalisedModel: string;
  /** The most recent spelling anyone used, for a table a human reads. */
  requestedModel: string;
  /** Rows. Forty people asking once and one person asking forty times both count forty. */
  requests: number;
  /** Distinct accounts — the number that separates those two cases. */
  requesters: number;
  /** Requests whose author asked to be told when it is served. */
  notifyRequests: number;
  firstRequestedAt: Date;
  lastRequestedAt: Date;
}

export interface DemandQuery {
  /** Only requests made at or after this instant. */
  since?: Date | null;
  /** Most-demanded first, capped at {@link MAX_DEMAND_ROWS}. Omit for every model asked for. */
  limit?: number | null;
}

/**
 * Rows either operator surface will answer with.
 *
 * Far above any real list of asks, and a bound rather than a page because the
 * export is meant to be opened whole in a spreadsheet. Both callers validate
 * against it, so neither can reach the query with a `LIMIT` the database would
 * refuse.
 */
export const MAX_DEMAND_ROWS = 10_000;

/**
 * "Request a model": the write, the per-account limit on it, and the aggregate
 * an operator reads.
 *
 * Nothing here deduplicates. A second ask for a model this account already
 * asked for is a second row, because the table is a vote count and a vote
 * refused is a vote lost — the limit below bounds the volume instead, and the
 * distinct-requester column in {@link ModelDemand} is what tells enthusiasm
 * from repetition.
 */
@Injectable()
export class ModelRequestsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(routerConfig.KEY) private readonly config: ConfigType<typeof routerConfig>,
  ) {}

  /**
   * Files one request, refusing the account that has had its allowance.
   *
   * The budget is counted over this table rather than held in a token bucket.
   * A bucket is per-process and per-boot, so a restart or a second replica
   * would hand the same account a fresh allowance; a rolling count over the
   * committed rows survives both and needs nothing the database is not already
   * storing. It costs one indexed count per submission, which is a price a
   * handful of requests an hour can pay.
   *
   * The count and the insert are not one transaction, so a burst of concurrent
   * submissions from one account can overshoot the budget by the size of the
   * burst — the same trade the `/v1` token limit makes, and the right one here:
   * a lock on every submission would cost more than the rows it saves, and the
   * thing being rationed is noise in a table, not money.
   */
  async record(input: RecordModelRequestInput): Promise<ModelRequest> {
    const repository = this.dataSource.getRepository(ModelRequest);
    const perDay = this.config.modelRequests.perAccountPerDay;

    const recent = await repository.countBy({
      userId: input.userId,
      createdAt: MoreThan(new Date(Date.now() - DAY_MS)),
    });
    if (recent >= perDay) {
      throw new ModelRequestRateLimitedError(perDay);
    }

    const requestedModel = input.requestedModel.trim();
    return repository.save(
      repository.create({
        id: randomUUID(),
        userId: input.userId,
        workspaceId: input.workspaceId,
        requestedModel,
        normalisedModel: normaliseModelName(requestedModel),
        note: input.note?.trim() || null,
        notify: input.notify,
        source: input.source,
        createdAt: new Date(),
      }),
    );
  }

  /**
   * Demand by model, most asked-for first.
   *
   * One `GROUP BY` rather than a rollup table, for the reason `InviteStatsService`
   * gives: an operator reads this a few times a week, and a cached counter would
   * be a second source of truth to keep correct.
   *
   * `requestedModel` is picked by `MAX(createdAt)` inside the group rather than
   * by an aggregate over the string, because "whatever sorts last alphabetically"
   * is not a spelling anybody chose. It costs one extra query over the groups on
   * the page, not one per row.
   */
  async demand(query: DemandQuery = {}): Promise<ModelDemand[]> {
    const builder = this.dataSource
      .getRepository(ModelRequest)
      .createQueryBuilder('request')
      .select('request.normalisedModel', 'normalisedModel')
      .addSelect('COUNT(*)', 'requests')
      .addSelect('COUNT(DISTINCT request.userId)', 'requesters')
      // Portable across both drivers, where `COUNT(*) FILTER (WHERE …)` is not.
      .addSelect('SUM(CASE WHEN request.notify THEN 1 ELSE 0 END)', 'notifyRequests')
      .addSelect('MIN(request.createdAt)', 'firstRequestedAt')
      .addSelect('MAX(request.createdAt)', 'lastRequestedAt')
      .groupBy('request.normalisedModel')
      .orderBy('requests', 'DESC')
      // The name breaks the tie on the count, so the list — and any test of it —
      // is stable rather than however the plan happened to emit the groups.
      .addOrderBy('request.normalisedModel', 'ASC');

    if (query.since) {
      builder.where('request.createdAt >= :since', { since: query.since.getTime() });
    }
    if (query.limit != null) {
      builder.limit(query.limit);
    }

    const groups = await builder.getRawMany<RawDemand>();
    const spellings = await this.spellingsOf(groups.map((group) => group.normalisedModel));

    return groups.map((group) => ({
      normalisedModel: group.normalisedModel,
      requestedModel: spellings.get(group.normalisedModel) ?? group.normalisedModel,
      requests: Number(group.requests),
      requesters: Number(group.requesters),
      notifyRequests: Number(group.notifyRequests ?? 0),
      firstRequestedAt: new Date(Number(group.firstRequestedAt)),
      lastRequestedAt: new Date(Number(group.lastRequestedAt)),
    }));
  }

  /**
   * The newest spelling of each of these keys — one row per key, never one per
   * request.
   *
   * The correlated subquery is what keeps that true: a plain `find` over the
   * keys would hydrate every row the export covers, which on a table whose
   * whole purpose is to grow is the one query here that could exhaust memory.
   * `id` breaks the tie on `createdAt`, because two requests filed in the same
   * millisecond must not make the answer depend on the plan.
   *
   * Chunked for the reason `InviteStatsService.countActivated` is: SQLite
   * refuses a statement with more than 999 bound parameters, and the unlimited
   * export can name more models than that.
   */
  private async spellingsOf(normalisedModels: string[]): Promise<Map<string, string>> {
    const spellings = new Map<string, string>();

    for (let at = 0; at < normalisedModels.length; at += IN_CHUNK) {
      const rows = await this.dataSource
        .getRepository(ModelRequest)
        .createQueryBuilder('request')
        .select('request.normalisedModel', 'normalisedModel')
        .addSelect('request.requestedModel', 'requestedModel')
        .where('request.normalisedModel IN (:...names)', { names: normalisedModels.slice(at, at + IN_CHUNK) })
        .andWhere((builder) => {
          const newest = builder
            .subQuery()
            .select('newest.id')
            .from(ModelRequest, 'newest')
            .where('newest.normalisedModel = request.normalisedModel')
            .orderBy('newest.createdAt', 'DESC')
            .addOrderBy('newest.id', 'DESC')
            .limit(1)
            .getQuery();
          return `request.id = ${newest}`;
        })
        .getRawMany<{ normalisedModel: string; requestedModel: string }>();

      for (const row of rows) {
        spellings.set(row.normalisedModel, row.requestedModel);
      }
    }
    return spellings;
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Bound parameters per `IN` clause; SQLite's ceiling is 999. */
const IN_CHUNK = 500;

/**
 * Aggregates come back as strings on both drivers (`bigint` on PostgreSQL,
 * whatever SQLite's `COUNT` yields), and the timestamps skip the entity
 * transformer because a raw query does — hence the conversions in `present`.
 */
interface RawDemand {
  normalisedModel: string;
  requests: string | number;
  requesters: string | number;
  notifyRequests: string | number | null;
  firstRequestedAt: string | number;
  lastRequestedAt: string | number;
}
