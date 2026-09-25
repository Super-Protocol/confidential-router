import { UseGuards } from '@nestjs/common';
import { Args, Query, Resolver } from '@nestjs/graphql';
import { AdminGuard, CurrentUser, SessionGuard, type SessionUser } from '../../../auth/index.js';
import { InviteStatsService, InvitesService } from '../../../invites/index.js';
import { InviteCampaignStatsModel, InviteGrantModel } from './invites.model.js';

/**
 * Invitation codes in the console.
 *
 * There is no mutation here, and that is the design: a code is spent inside
 * account creation and nowhere else (`invites.service.ts`), so exposing a
 * "redeem" field would be exposing the one thing that must not be callable
 * twice. What the console can do is *read* — whether the credit landed, and, for
 * an operator, how the campaign is going.
 */
@Resolver()
export class InvitesResolver {
  constructor(
    private readonly invites: InvitesService,
    private readonly stats: InviteStatsService,
  ) {}

  /**
   * The signed-in account's invitation credit, or `null`.
   *
   * This is how the console confirms what the sign-up could not tell it: Better
   * Auth owns the sign-up response, so the grant's outcome is not in it. A
   * visitor who arrived with a code and finds `null` here was not credited, and
   * the onboarding screen says so (SUP-145).
   */
  @Query(() => InviteGrantModel, {
    nullable: true,
    description: 'The viewer’s invitation credit, or null if they never redeemed one.',
  })
  @UseGuards(SessionGuard)
  async inviteGrant(@CurrentUser() user: SessionUser): Promise<InviteGrantModel | null> {
    const redemption = await this.invites.redemptionOf(user.id);
    if (!redemption?.inviteCode) {
      return null;
    }
    return {
      creditTransactionId: redemption.creditTransactionId,
      grantMicros: String(redemption.inviteCode.grantMicros),
      campaign: redemption.inviteCode.campaign,
      redeemedAt: redemption.redeemedAt,
    };
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
}
