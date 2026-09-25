import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { routerConfig } from '../config.js';
import { FeedbackSubmission } from '../db/entities/feedback-submission.entity.js';
import { Generation } from '../db/entities/generation.entity.js';
import { InviteRedemption } from '../db/entities/invite-redemption.entity.js';
import { Workspace } from '../db/entities/workspace.entity.js';

/**
 * Why an account is not being offered the second grant.
 *
 * Told to the console, which uses it to decide what to show and — for
 * `already_granted` — what to say instead of the offer. It is not told to
 * anyone unauthenticated: every path that produces one is behind a session or a
 * signed webhook.
 */
export type FeedbackIneligibleReason =
  /** No form is configured on this deployment. */
  | 'disabled'
  /** The account never redeemed an invitation, so there is no first grant to report on. */
  | 'no_first_grant'
  /** It already took a feedback grant. One per account, ever. */
  | 'already_granted'
  /** There is still credit left; the question is premature. */
  | 'balance_healthy'
  /** The first grant was never spent on anything, so there is nothing to tell us. */
  | 'no_usage';

export type FeedbackEligibility =
  | { eligible: true; workspaceId: string; grantMicros: number }
  | { eligible: false; reason: FeedbackIneligibleReason; workspaceId: string | null };

export interface EvaluateOptions {
  /**
   * Skip the balance test.
   *
   * Used when a submission arrives: the account was eligible when the console
   * minted its token, minutes ago, and a top-up between opening the form and
   * submitting it must not cost someone the grant they were promised for
   * filling it in.
   */
  ignoreBalance?: boolean;
}

/**
 * Who may be offered the second $100, decided here and never in the browser.
 *
 * All four conditions from SUP-149, in the order that produces the most useful
 * reason: the account redeemed a first grant, has not already taken a feedback
 * grant, has run its balance down, and actually sent requests.
 *
 * The workspace is not asked for — it is the one the first grant landed in,
 * read from the redemption row. That removes the only ambiguous input (an
 * account can own more than one workspace) and makes the whole evaluation a
 * function of the user id.
 */
@Injectable()
export class FeedbackEligibilityService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(routerConfig.KEY) private readonly config: ConfigType<typeof routerConfig>,
  ) {}

  async evaluate(userId: string, options: EvaluateOptions = {}): Promise<FeedbackEligibility> {
    if (!this.config.feedback.form) {
      return { eligible: false, reason: 'disabled', workspaceId: null };
    }

    const redemption = await this.dataSource.getRepository(InviteRedemption).findOne({ where: { userId } });
    if (!redemption) {
      return { eligible: false, reason: 'no_first_grant', workspaceId: null };
    }
    const workspaceId = redemption.workspaceId;

    if (await this.grantOf(userId)) {
      return { eligible: false, reason: 'already_granted', workspaceId };
    }

    if (!options.ignoreBalance) {
      const workspace = await this.dataSource
        .getRepository(Workspace)
        .findOne({ where: { id: workspaceId }, select: { id: true, balanceMicros: true } });
      if (!workspace || workspace.balanceMicros >= this.config.feedback.offerBelowMicros) {
        return { eligible: false, reason: 'balance_healthy', workspaceId };
      }
    }

    if ((await this.meteredTokens(workspaceId)) < this.config.feedback.minMeteredTokens) {
      return { eligible: false, reason: 'no_usage', workspaceId };
    }

    return { eligible: true, workspaceId, grantMicros: this.config.feedback.grantMicros };
  }

  /** The account's feedback grant, or null. The unique index guarantees at most one. */
  grantOf(userId: string): Promise<FeedbackSubmission | null> {
    return this.dataSource.getRepository(FeedbackSubmission).findOne({ where: { grantedUserId: userId } });
  }

  /**
   * Tokens this workspace has actually put through a model.
   *
   * Prompt plus completion, summed over the generations table — the same table
   * `inviteCampaignStats` calls "activated", counted rather than merely
   * existing, because one empty request is not usage.
   */
  private async meteredTokens(workspaceId: string): Promise<number> {
    const row = await this.dataSource
      .getRepository(Generation)
      .createQueryBuilder('generation')
      .where('generation.workspaceId = :workspaceId', { workspaceId })
      .select('SUM(generation.promptTokens + generation.completionTokens)', 'total')
      .getRawOne<{ total: string | number | null }>();
    return Number(row?.total ?? 0);
  }
}
