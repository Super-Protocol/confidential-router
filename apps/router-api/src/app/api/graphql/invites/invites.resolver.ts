import { BadRequestException, Inject, Logger, UseGuards } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { AdminGuard, CurrentUser, SessionGuard, type SessionUser } from '../../../auth/index.js';
import { routerConfig } from '../../../config.js';
import type { InviteRedemption } from '../../../db/entities/invite-redemption.entity.js';
import { type InviteLookup, InviteStatsService, InvitesService, normaliseInviteCode } from '../../../invites/index.js';
import {
  describeRestoration,
  describeWithdrawal,
  InviteTargetError,
  InviteWithdrawalService,
} from '../../../invites/invite-withdrawal.service.js';
import { InviteRateLimitedError } from '../../../invites/invites.errors.js';
import { RATE_LIMITER, type RateLimiter } from '../../v1/rate-limiter.js';
import {
  DisableInviteCodesInputModel,
  InviteCampaignStatsModel,
  InviteGrantModel,
  InviteGrantStatusModel,
  InviteRefusalReason,
  InviteRestorationModel,
  InviteWithdrawalModel,
  RestoreInviteCodesInputModel,
} from './invites.model.js';

/**
 * Invitation codes in the console.
 *
 * Nothing here *spends* a code, and that is the design: a code is redeemed inside
 * account creation and nowhere else (`invites.service.ts`), so exposing a "redeem"
 * field would be exposing the one thing that must not be callable twice. Minting
 * is absent for the same reason, and stays a CLI.
 *
 * The two operator mutations run in the other direction. `disableInviteCodes`
 * only ever *stops* credit, and it is here because a deployment whose cluster
 * space is published has no `kubectl exec` to reach the CLI with — a kill switch
 * that cannot be pulled on the cluster the codes were mailed for is not a kill
 * switch (SUP-159). Both are behind `auth.adminEmails`, like the campaign
 * aggregates.
 */
@Resolver()
export class InvitesResolver {
  private readonly logger = new Logger(InvitesResolver.name);

  // biome-ignore lint/complexity/useMaxParams: a Nest DI constructor has no call site to keep readable.
  constructor(
    private readonly invites: InvitesService,
    private readonly stats: InviteStatsService,
    private readonly withdrawals: InviteWithdrawalService,
    @Inject(routerConfig.KEY) private readonly config: ConfigType<typeof routerConfig>,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
  ) {}

  /**
   * The signed-in account's invitation credit, or `null`.
   *
   * This is how the console confirms what the sign-up could not tell it: Better
   * Auth owns the sign-up response, so the grant's outcome is not in it. A
   * visitor who arrived with a code and finds `null` here was not credited, and
   * `inviteGrantStatus` is what says why.
   */
  @Query(() => InviteGrantModel, {
    nullable: true,
    description: 'The viewer’s invitation credit, or null if they never redeemed one.',
  })
  @UseGuards(SessionGuard)
  async inviteGrant(@CurrentUser() user: SessionUser): Promise<InviteGrantModel | null> {
    const redemption = await this.invites.redemptionOf(user.id);
    return redemption?.inviteCode ? grantOf(redemption) : null;
  }

  /**
   * The same credit, plus the reason there is none — the post-sign-up screen.
   *
   * It takes the code because nothing persists a *refusal*: the redemption path
   * writes a row when it succeeds and deliberately writes nothing when it does
   * not, so the only thing that still knows which code was presented is the
   * browser that presented it. The console keeps the code from the invitation URL
   * and hands it back here.
   *
   * The typed reason is safe to answer where the anonymous lookup's is not. This
   * caller holds a session and already holds the code, so "expired" tells them
   * nothing they could not have learnt by trying it — and `ALREADY_REDEEMED`,
   * the one reason that depends on *who* is asking, is only answerable here.
   *
   * It spends the invitation-lookup budget, keyed by account: signed in or not, a
   * caller must not get a second allowance for asking about codes.
   */
  @Query(() => InviteGrantStatusModel, {
    description: 'The viewer’s invitation credit, or why the code they signed up with did not apply.',
  })
  @UseGuards(SessionGuard)
  async inviteGrantStatus(
    @CurrentUser() user: SessionUser,
    @Args('code', { type: () => String, nullable: true, description: 'The code the sign-up carried, if any.' })
    code?: string,
  ): Promise<InviteGrantStatusModel> {
    const redemption = await this.invites.redemptionOf(user.id);
    if (redemption?.inviteCode) {
      // A code was presented that is not the one this account redeemed: the
      // account has its grant, and the code it just tried bought nothing. Both
      // halves are true and the screen says both.
      const other = code !== undefined && normaliseInviteCode(code) !== redemption.inviteCode.code;
      return { grant: grantOf(redemption), reason: other ? InviteRefusalReason.ALREADY_REDEEMED : null };
    }

    if (code === undefined || code.trim().length === 0) {
      return { grant: null, reason: null };
    }

    await this.admit(user.id);
    return { grant: null, reason: refusalOf(await this.invites.lookup(code)) };
  }

  /** Campaign aggregates. `auth.adminEmails` only — see `AdminGuard`. */
  @Query(() => [InviteCampaignStatsModel], {
    description: 'Invitation campaign conversion. Restricted to auth.adminEmails.',
  })
  @UseGuards(SessionGuard, AdminGuard)
  async inviteCampaigns(
    @Args('campaign', { type: () => String, nullable: true }) campaign?: string,
  ): Promise<InviteCampaignStatsModel[]> {
    const campaigns = await this.stats.campaigns(campaign ?? null);
    return campaigns.map((entry) => ({ ...entry, grantedMicros: String(entry.grantedMicros) }));
  }

  /**
   * Withdraws a leaked code, or a whole mailing. `auth.adminEmails` only.
   *
   * The counterpart of `invites disable` and the same code underneath. It takes
   * no confirmation flag: the operator reaching for this has a code in the wild,
   * and `restoreInviteCodes` is the undo.
   *
   * **No grant already made is affected** — `disabledAt` is read when a seat is
   * claimed and nowhere else, so balances, `credit_transactions` and
   * `invite_redemptions` are untouched. Withdrawing a campaign stops the next
   * sign-up, not the accounts that already have their credit.
   *
   * It writes a WARN naming the operator. On a published cluster the container
   * log is the only audit trail there is, and retiring a mailing is the one
   * invitation operation someone may later have to prove they performed — the
   * CLI's equivalent is the line it prints to whoever ran it.
   */
  @Mutation(() => InviteWithdrawalModel, {
    description:
      'Withdraws one invitation code or a campaign’s. Credit already granted is untouched. Restricted to auth.adminEmails.',
  })
  @UseGuards(SessionGuard, AdminGuard)
  async disableInviteCodes(
    @CurrentUser() user: SessionUser,
    @Args('input') input: DisableInviteCodesInputModel,
  ): Promise<InviteWithdrawalModel> {
    const result = await this.targeted(() =>
      this.withdrawals.withdraw({ ...input, unspentOnly: input.unspentOnly === true }),
    );
    this.logger.warn(`Invitation codes withdrawn by ${user.email} — ${describeWithdrawal(result)}`);
    return result;
  }

  /** Puts withdrawn codes back. The undo for a mistyped campaign tag. */
  @Mutation(() => InviteRestorationModel, {
    description: 'Puts withdrawn invitation codes back into circulation. Restricted to auth.adminEmails.',
  })
  @UseGuards(SessionGuard, AdminGuard)
  async restoreInviteCodes(
    @CurrentUser() user: SessionUser,
    @Args('input') input: RestoreInviteCodesInputModel,
  ): Promise<InviteRestorationModel> {
    const result = await this.targeted(() => this.withdrawals.restore(input));
    this.logger.warn(`Invitation codes restored by ${user.email} — ${describeRestoration(result)}`);
    return result;
  }

  /**
   * Naming neither target, or both, or something that is not a code, is the
   * caller's mistake — a 400 and the service's own sentence, rather than an
   * `INTERNAL_SERVER_ERROR` that tells an operator under pressure nothing.
   */
  private async targeted<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw error instanceof InviteTargetError ? new BadRequestException(error.message) : error;
    }
  }

  private async admit(userId: string): Promise<void> {
    const decision = await this.limiter.consume(`invite:user:${userId}`, {
      cost: 1,
      limitPerMinute: this.config.invites.lookupsPerMinute,
    });
    if (!decision.allowed) {
      throw new InviteRateLimitedError();
    }
  }
}

function grantOf(redemption: InviteRedemption): InviteGrantModel {
  return {
    creditTransactionId: redemption.creditTransactionId,
    grantMicros: String(redemption.inviteCode?.grantMicros ?? 0),
    campaign: redemption.inviteCode?.campaign ?? '',
    redeemedAt: redemption.redeemedAt,
  };
}

/**
 * A lookup that came back valid, for an account with no grant, is not a code
 * problem: the code is still redeemable and this account simply did not get it,
 * which only happens when the redemption itself failed.
 */
function refusalOf(lookup: InviteLookup): InviteRefusalReason {
  if (lookup.valid) {
    return InviteRefusalReason.ERROR;
  }
  switch (lookup.reason) {
    case 'expired':
      return InviteRefusalReason.EXPIRED;
    case 'exhausted':
      return InviteRefusalReason.EXHAUSTED;
    case 'disabled':
      return InviteRefusalReason.DISABLED;
    default:
      return InviteRefusalReason.NOT_FOUND;
  }
}
