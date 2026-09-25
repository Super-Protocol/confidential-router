import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager } from 'typeorm';
import { isUniqueViolation, LedgerService } from '../billing/index.js';
import { type FeedbackRefusalReason, FeedbackSubmission } from '../db/entities/feedback-submission.entity.js';
import { InviteRedemption } from '../db/entities/invite-redemption.entity.js';
import { FEEDBACK_ANALYTICS, type FeedbackAnalytics } from './feedback-analytics.js';
import type { FeedbackDelivery } from './typeform.js';

/**
 * `reference` on the ledger entry a feedback grant writes.
 *
 * The Credits screen reads it to tell the second grant from the first: both are
 * `kind: grant`, and an entry that named neither would leave the viewer to guess
 * which $100 they were looking at.
 */
export const FEEDBACK_GRANT_REFERENCE = 'feedback';

export type FeedbackDeliveryOutcome =
  | { status: 'granted'; grantMicros: number; creditTransactionId: string }
  /** The same submission arrived before and was already settled. Nothing was written. */
  | { status: 'replayed' }
  /** Not a form submission — some other event type the provider sends. */
  | { status: 'ignored' }
  | { status: 'refused'; reason: FeedbackRefusalReason };

export interface SettlementInput {
  delivery: FeedbackDelivery;
  userId: string;
  workspaceId: string;
  provider: string;
}

export interface GrantInput extends SettlementInput {
  grantMicros: number;
}

export interface RefusalInput extends SettlementInput {
  reason: FeedbackRefusalReason;
  /** Whether to keep the answers. False where the token named an account we have not got. */
  store: boolean;
}

/**
 * Everything the second grant writes, and the event that says it happened.
 *
 * Separate from `FeedbackService` because the two have different jobs: that one
 * decides, this one records — and keeping the decision out of the write is what
 * lets the write be one transaction with no branches in it.
 *
 * Two of the three locks against a double grant are enforced here, and neither
 * is a check in code: the unique `submissionId` on the row inserted below, and
 * the ledger's unique `idempotencyKey`, `feedback:<userId>`. Both run in the one
 * transaction `LedgerService.transaction` opens, so losing either leaves nothing
 * behind. (The third, the unique nullable `grantedUserId`, is the same insert's
 * other index.)
 */
@Injectable()
export class FeedbackGrantRecorder {
  private readonly logger = new Logger(FeedbackGrantRecorder.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly ledger: LedgerService,
    @Inject(FEEDBACK_ANALYTICS) private readonly analytics: FeedbackAnalytics,
  ) {}

  /** Whether this submission has already been decided about. */
  async settled(submissionId: string): Promise<boolean> {
    return (await this.dataSource.getRepository(FeedbackSubmission).countBy({ submissionId })) > 0;
  }

  /**
   * Credits the account and files the submission, in one transaction.
   *
   * A unique-index violation here is the guarantee working rather than a
   * failure: two submissions from the same account racing, or a redelivery that
   * slipped past the `settled` check. Either way the account has its grant and
   * this delivery did not write one.
   */
  async grant(input: GrantInput): Promise<FeedbackDeliveryOutcome> {
    try {
      const outcome = await this.write(input);
      this.logger.log(`Feedback grant applied to user ${input.userId}: ${input.grantMicros} micro-USD credited.`);
      this.analytics.grantApplied({
        uuid: outcome.creditTransactionId,
        distinctId: input.userId,
        outcome: 'granted',
        grantMicros: input.grantMicros,
      });
      return outcome;
    } catch (error) {
      if (isUniqueViolation(error)) {
        return this.refuse({ ...input, reason: 'already_granted', store: false });
      }
      this.logger.error(
        `Feedback grant failed for user ${input.userId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return this.refuse({ ...input, reason: 'error', store: false });
    }
  }

  /**
   * Files a submission that earned nothing, and says so.
   *
   * The answers are kept even though no credit moved: the second grant buys
   * information, and a refusal does not make the information worthless.
   * `grantedUserId` stays null, which is what lets the unique index on it stand
   * for the one-per-account policy while this row sits beside a credited one.
   */
  async refuse(input: RefusalInput): Promise<FeedbackDeliveryOutcome> {
    if (input.store) {
      try {
        await this.insert(this.dataSource.manager, { ...input, settlement: refusalOf(input.reason) });
      } catch (error) {
        // A concurrent redelivery of the same submission. The row exists and the
        // refusal is recorded; nothing here is worth failing the webhook over.
        if (!isUniqueViolation(error)) {
          throw error;
        }
      }
    }
    this.analytics.grantApplied({
      uuid: input.delivery.submissionId,
      distinctId: input.userId,
      outcome: 'refused',
      grantMicros: 0,
      reason: input.reason,
    });
    return { status: 'refused', reason: input.reason };
  }

  private async write(input: GrantInput): Promise<{
    status: 'granted';
    grantMicros: number;
    creditTransactionId: string;
  }> {
    const campaign = await this.campaignOf(input.userId);

    return this.ledger.transaction(input.workspaceId, async (manager) => {
      const entry = await this.ledger.appendWithin(manager, {
        workspaceId: input.workspaceId,
        kind: 'grant',
        amountMicros: input.grantMicros,
        // `reference` names the origin the way an invitation grant names its
        // campaign; the campaign rides in the description, so a feedback grant
        // stays attributable to the mailing that produced the account.
        reference: FEEDBACK_GRANT_REFERENCE,
        description: campaign ? `Feedback grant · ${campaign}` : 'Feedback grant',
        idempotencyKey: `feedback:${input.userId}`,
      });
      await this.insert(manager, {
        ...input,
        settlement: {
          grantedUserId: input.userId,
          grantMicros: input.grantMicros,
          creditTransactionId: entry.transaction.id,
          refusalReason: null,
        },
      });
      return { status: 'granted' as const, grantMicros: input.grantMicros, creditTransactionId: entry.transaction.id };
    });
  }

  /**
   * `save` rather than `insert` because the row carries a JSON column: TypeORM's
   * `insert` types every nested value of one as a partial entity, and the
   * answers are a provider's shape rather than ours. The id is minted here, so
   * this is an insert whatever the method is called — the same way
   * `EvidenceService` writes its bundle.
   */
  private insert(
    manager: EntityManager,
    input: SettlementInput & {
      settlement: Pick<FeedbackSubmission, 'grantedUserId' | 'grantMicros' | 'creditTransactionId' | 'refusalReason'>;
    },
  ): Promise<FeedbackSubmission> {
    return manager.save(
      manager.create(FeedbackSubmission, {
        id: randomUUID(),
        provider: input.provider,
        formId: input.delivery.formId,
        submissionId: input.delivery.submissionId,
        userId: input.userId,
        workspaceId: input.workspaceId,
        answers: input.delivery.answers,
        submittedAt: input.delivery.submittedAt,
        createdAt: new Date(),
        ...input.settlement,
      }),
    );
  }

  /** The campaign the account's first grant came from, for the ledger description. */
  private async campaignOf(userId: string): Promise<string | null> {
    const redemption = await this.dataSource
      .getRepository(InviteRedemption)
      .findOne({ where: { userId }, relations: { inviteCode: true } });
    return redemption?.inviteCode?.campaign ?? null;
  }
}

function refusalOf(reason: FeedbackRefusalReason) {
  return { grantedUserId: null, grantMicros: null, creditTransactionId: null, refusalReason: reason };
}
