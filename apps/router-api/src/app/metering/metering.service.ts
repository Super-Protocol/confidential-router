import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AnalyticsService, eventUuid } from '../analytics/index.js';
import { ApiKeyService } from '../api-keys/api-key.service.js';
import { Generation, type GenerationStatus } from '../db/entities/generation.entity.js';
import { Workspace } from '../db/entities/workspace.entity.js';
import { WorkspaceMember } from '../db/entities/workspace-member.entity.js';
import { InviteAttributionService } from '../invites/invite-attribution.service.js';
import { CREDITS_GATEWAY, type CreditsGateway } from './credits.gateway.js';

/** An hour, in milliseconds. `hours_since_signup` is whole hours, floored. */
const MS_PER_HOUR = 3_600_000;

/**
 * Everything that is true about a request the moment it is admitted, before a
 * byte of it is forwarded. No prompt, no completion, no headers —
 * `data-model.md` invariant 1, enforced by `invariants.spec.ts`.
 *
 * The prices are here rather than on the outcome because they are frozen at
 * admission: a config reload mid-generation must not re-price it.
 */
export interface AdmittedGeneration {
  id: string;
  workspaceId: string;
  apiKeyId: string;
  modelId: string;
  /** This deployment's endpoint, or null when the request went to an external one. */
  endpointId: string | null;
  /** The external endpoint the request went to, or null for a model in this cluster space. */
  externalEndpointId: string | null;
  evidenceSnapshotId: string | null;
  evidenceDigest: string | null;
  promptPer1mMicros: number;
  completionPer1mMicros: number;
  streamed: boolean;
  requestId: string | null;
  clientIpHash: string | null;
  createdAt: Date;
}

/** What the request turned out to be, once the gateway is done with it. */
export interface GenerationOutcomeRecord {
  promptTokens: number;
  completionTokens: number;
  costMicros: number;
  status: GenerationStatus;
  errorCode: string | null;
  finishReason: string | null;
  latencyMs: number;
  timeToFirstTokenMs: number | null;
  tokensPerSecond: number | null;
}

/** One finished request: what was admitted, plus what came of it. */
export type MeteringRecord = AdmittedGeneration & GenerationOutcomeRecord;

/**
 * The meter, in the two phases one request has.
 *
 * {@link open} writes the row at admission; {@link close} replaces it with the
 * outcome and settles the money. Both are called from the gateway, including on
 * the error and abort paths, because a request that consumed tokens before
 * failing still consumed them — and because a request that consumed none still
 * happened, which is the whole of SUP-423.
 *
 * Failures here are logged and swallowed. On `open` the request has not been
 * forwarded yet and refusing it over a metering write would turn a database
 * hiccup into an outage; on `close` the response has already been sent, and
 * losing a metering row is better than turning a served generation into a 500.
 */
@Injectable()
export class MeteringService {
  private readonly logger = new Logger(MeteringService.name);

  // biome-ignore lint/complexity/useMaxParams: a Nest DI constructor has no call site to keep readable.
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(CREDITS_GATEWAY) private readonly credits: CreditsGateway,
    private readonly apiKeys: ApiKeyService,
    private readonly analytics: AnalyticsService,
    private readonly attribution: InviteAttributionService,
  ) {}

  /**
   * Opens the row for a request that has been admitted and is about to be
   * forwarded.
   *
   * `pending`, zero tokens, zero cost: a true statement about a request whose
   * outcome is not known yet, and the only statement available if the router
   * does not survive to make a better one.
   */
  async open(admitted: AdmittedGeneration): Promise<void> {
    try {
      await this.dataSource.getRepository(Generation).insert({
        ...admitted,
        promptTokens: 0,
        completionTokens: 0,
        costMicros: 0,
        status: 'pending',
        errorCode: null,
        finishReason: null,
        latencyMs: 0,
        timeToFirstTokenMs: null,
        tokensPerSecond: null,
      });
    } catch (error) {
      // Swallowed, like a failed close: the caller is on the request path and
      // the client asked for a completion, not for a metering guarantee. `close`
      // notices the missing row and inserts it then.
      this.logger.error(
        `Failed to open generation ${admitted.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Closes the row with what actually happened, and settles the money.
   *
   * An `UPDATE` that matches nothing means {@link open} never landed — a
   * database that was unavailable then and is available now — so the full row is
   * inserted instead. The alternative, letting the update silently match no
   * rows, is the invisible generation this method exists to prevent.
   *
   * That insert has a catch of its own, and the order matters: a row this
   * deployment failed to write is a reporting loss, while a generation that was
   * served and never debited is a billing one. The settle below must not be
   * skipped over the lesser of the two.
   */
  async close(record: MeteringRecord): Promise<void> {
    try {
      const closed = await this.dataSource.getRepository(Generation).update({ id: record.id }, outcomeOf(record));
      if (!closed.affected) {
        try {
          await this.dataSource.getRepository(Generation).insert(record);
        } catch (error) {
          this.logger.error(
            `Failed to write the metering row for generation ${record.id}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      await this.apiKeys.recordSpend(record.apiKeyId, record.costMicros);
      await this.credits.debit({
        workspaceId: record.workspaceId,
        generationId: record.id,
        amountMicros: record.costMicros,
      });
    } catch (error) {
      this.logger.error(
        `Failed to meter generation ${record.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    try {
      await this.reportFirstRequest(record);
    } catch (error) {
      // Its own catch, so a failure here cannot be read as a lost metering row —
      // the meter is committed by this point, and only the chart is affected.
      this.logger.warn(
        `Could not report first_request_sent for workspace ${record.workspaceId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * `first_request_sent`, exactly once per workspace.
   *
   * The event the whole launch campaign is judged on — an account that redeemed
   * $100 and never sent a token did not convert — so "exactly once" has to be a
   * property of the write rather than of a count. One conditional `UPDATE` claims
   * the workspace's `firstRequestAt`; several generations finishing in the same
   * millisecond all issue it and exactly one reports a row affected, the same
   * shape `LedgerService.append` and `claimSeat` use and for the same reason:
   * SQLite has neither row locks nor `SELECT … FOR UPDATE`.
   *
   * Counting `generations` instead would be a read followed by a decision, which
   * is a race on the one path where concurrent requests are the normal case.
   */
  private async reportFirstRequest(record: MeteringRecord): Promise<void> {
    const column = (name: string): string => this.dataSource.driver.escape(name);
    const claimed = await this.dataSource
      .createQueryBuilder()
      .update(Workspace)
      .set({ firstRequestAt: record.createdAt })
      .where('id = :id', { id: record.workspaceId })
      .andWhere(`${column('firstRequestAt')} IS NULL`)
      .execute();

    if (!claimed.affected) {
      return;
    }

    // The workspace is personal, so its owner is the account the funnel follows.
    // A workspace with no owner cannot happen — `ensurePersonalWorkspace` writes
    // one with the workspace — and if it somehow did, an anonymous
    // `first_request_sent` would be a row nothing can be concluded from, which is
    // worse than the gap.
    const ownerId = await this.ownerOf(record.workspaceId);
    if (!ownerId) {
      this.logger.warn(`Workspace ${record.workspaceId} has no owner; first_request_sent not reported.`);
      return;
    }

    const workspace = await this.dataSource.getRepository(Workspace).findOne({ where: { id: record.workspaceId } });
    const attribution = await this.attribution.forWorkspace(record.workspaceId);

    await this.analytics.capture({
      event: 'first_request_sent',
      distinctId: ownerId,
      uuid: eventUuid('first_request_sent', record.workspaceId),
      timestamp: record.createdAt,
      properties: {
        campaign: attribution.campaign,
        had_invite_grant: attribution.hadInviteGrant,
        model_slug: record.modelId,
        hours_since_signup: workspace
          ? Math.max(0, Math.floor((record.createdAt.getTime() - workspace.createdAt.getTime()) / MS_PER_HOUR))
          : 0,
      },
    });
  }

  /**
   * The account the workspace's events are attributed to: its owner.
   *
   * Read from `workspace_members` rather than carried on the request, because the
   * request authenticated with an API key and a key has no user — the account
   * that created it may have left the workspace since.
   */
  private async ownerOf(workspaceId: string): Promise<string | null> {
    const owner = await this.dataSource
      .getRepository(WorkspaceMember)
      .findOne({ where: { workspaceId, role: 'owner' } });

    return owner?.userId ?? null;
  }
}

/**
 * The columns `close` overwrites: everything the outcome decides, and nothing
 * the admission already settled.
 *
 * Spelled out rather than spread from the record, so a field added to
 * {@link AdmittedGeneration} cannot start being rewritten at close time — the
 * frozen prices and `createdAt` are the ones that would quietly stop being
 * frozen.
 */
function outcomeOf(record: MeteringRecord): GenerationOutcomeRecord {
  return {
    promptTokens: record.promptTokens,
    completionTokens: record.completionTokens,
    costMicros: record.costMicros,
    status: record.status,
    errorCode: record.errorCode,
    finishReason: record.finishReason,
    latencyMs: record.latencyMs,
    timeToFirstTokenMs: record.timeToFirstTokenMs,
    tokensPerSecond: record.tokensPerSecond,
  };
}
