import { Inject, UseGuards } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Args, Query, Resolver } from '@nestjs/graphql';
import { AdminGuard, CurrentUser, SessionGuard, type SessionUser } from '../../../auth/index.js';
import { routerConfig } from '../../../config.js';
import type { InviteRedemption } from '../../../db/entities/invite-redemption.entity.js';
import { type InviteLookup, InviteStatsService, InvitesService, normaliseInviteCode } from '../../../invites/index.js';
import { InviteRateLimitedError } from '../../../invites/invites.errors.js';
import { RATE_LIMITER, type RateLimiter } from '../../v1/rate-limiter.js';
import {
  InviteCampaignStatsModel,
  InviteGrantModel,
  InviteGrantStatusModel,
  InviteRefusalReason,
} from './invites.model.js';

/**
 * Invitation codes in the console.
 *
 * There is no mutation here, and that is the design: a code is spent inside
 * account creation and nowhere else (`invites.service.ts`), so exposing a
 * "redeem" field would be exposing the one thing that must not be callable
 * twice. What the console can do is *read* — whether the credit landed, why it
 * did not, and, for an operator, how the campaign is going.
 */
@Resolver()
export class InvitesResolver {
  // biome-ignore lint/complexity/useMaxParams: a Nest DI constructor has no call site to keep readable.
  constructor(
    private readonly invites: InvitesService,
    private readonly stats: InviteStatsService,
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
