import { BadRequestException, Inject, Logger, UseGuards } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { AdminGuard, CurrentUser, SessionGuard, type SessionUser } from '../../../auth/index.js';
import { routerConfig } from '../../../config.js';
import {
  type AdminInviteCode,
  type AdminSignUp,
  InviteAdminService,
  type InviteCodeStatus,
  type SignUpOrigin,
} from '../../../invites/invite-admin.service.js';
import { formatInviteCode, inviteUrl } from '../../../invites/invite-code.js';
import { InviteStatsService } from '../../../invites/invite-stats.service.js';
import { describeWithdrawal, InviteWithdrawalService } from '../../../invites/invite-withdrawal.service.js';
import {
  type AdminInviteCodeModel,
  AdminInviteCodePageModel,
  AdminInviteCodesArgs,
  type AdminSignUpModel,
  AdminSignUpPageModel,
  AdminSignUpsArgs,
  InviteCodeStatusEnum,
  InviteStatisticsArgs,
  InviteStatisticsModel,
  IssuedInviteCodesModel,
  IssueInviteCodesInputModel,
  MAX_ISSUE_GRANT_MICROS,
  SignUpOriginEnum,
  WithdrawInviteCodeArgs,
} from './invite-admin.model.js';
import { InviteWithdrawalModel } from './invites.model.js';

/**
 * The admin console's Invitations section: issue codes, see who redeemed which,
 * and how sign-ups are going (SUP-268).
 *
 * Every field is behind `SessionGuard` + `AdminGuard` — `auth.adminEmails` —
 * so a member who finds the route gets a 403 from the API, not merely a hidden
 * link. Codes are answered in full here, because issuing and handing them out is
 * this section's job; the console masks them until asked, and **nothing here
 * logs one**. The audit lines name the operator, the campaign and the row id.
 */
@Resolver()
@UseGuards(SessionGuard, AdminGuard)
export class InviteAdminResolver {
  private readonly logger = new Logger(InviteAdminResolver.name);

  // biome-ignore lint/complexity/useMaxParams: a Nest DI constructor has no call site to keep readable.
  constructor(
    private readonly admin: InviteAdminService,
    private readonly stats: InviteStatsService,
    private readonly withdrawals: InviteWithdrawalService,
    @Inject(routerConfig.KEY) private readonly config: ConfigType<typeof routerConfig>,
  ) {}

  @Query(() => AdminInviteCodePageModel, {
    description: 'Invitation codes, newest first, with who redeemed each. Restricted to auth.adminEmails.',
  })
  async adminInviteCodes(@Args() args: AdminInviteCodesArgs): Promise<AdminInviteCodePageModel> {
    const page = await this.admin.codes({
      campaign: args.campaign ?? null,
      status: args.status ? (args.status.toLowerCase() as InviteCodeStatus) : null,
      offset: args.offset,
      limit: args.limit,
    });
    return { totalCount: page.totalCount, nodes: page.nodes.map((code) => this.codeOf(code)) };
  }

  @Query(() => AdminSignUpPageModel, {
    description: 'Accounts, newest first, with how each came to exist. Restricted to auth.adminEmails.',
  })
  async adminSignUps(@Args() args: AdminSignUpsArgs): Promise<AdminSignUpPageModel> {
    const page = await this.admin.signUps(
      {
        origin: args.origin ? (args.origin.toLowerCase() as SignUpOrigin) : null,
        offset: args.offset,
        limit: args.limit,
      },
      this.config.auth.bootstrapEmail,
    );
    return { totalCount: page.totalCount, nodes: page.nodes.map(signUpOf) };
  }

  @Query(() => InviteStatisticsModel, {
    description: 'Invitation totals, a daily series and the per-campaign breakdown. Restricted to auth.adminEmails.',
  })
  async inviteStatistics(@Args() args: InviteStatisticsArgs): Promise<InviteStatisticsModel> {
    const bootstrapId = await this.admin.bootstrapAccountId(this.config.auth.bootstrapEmail);
    const [totals, daily, campaigns] = await Promise.all([
      this.stats.totals(),
      this.stats.daily(args.days, bootstrapId),
      this.stats.campaigns(),
    ]);
    return {
      totals: { ...totals, grantedMicros: String(totals.grantedMicros) },
      daily,
      campaigns: campaigns.map((entry) => ({ ...entry, grantedMicros: String(entry.grantedMicros) })),
    };
  }

  /**
   * Mints a batch. The codes come back once, in this response; the console's
   * list can show them again, but this is the one the operator copies from.
   */
  @Mutation(() => IssuedInviteCodesModel, {
    description: 'Issues invitation codes. Restricted to auth.adminEmails.',
  })
  async issueInviteCodes(
    @CurrentUser() user: SessionUser,
    @Args('input') input: IssueInviteCodesInputModel,
  ): Promise<IssuedInviteCodesModel> {
    const grantMicros = Number(input.grantMicros);
    if (!Number.isSafeInteger(grantMicros) || grantMicros <= 0 || grantMicros > MAX_ISSUE_GRANT_MICROS) {
      throw new BadRequestException(
        `The credit per code must be more than $0 and at most $${MAX_ISSUE_GRANT_MICROS / 1_000_000}.`,
      );
    }
    const expiresAt = input.expiresAt ?? null;
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('The expiry is in the past, so the codes could never be redeemed.');
    }

    const codes = await this.admin.issue({
      count: input.count,
      grantMicros,
      campaign: input.campaign,
      maxRedemptions: input.maxRedemptions,
      expiresAt,
      note: input.note?.trim() ? input.note.trim() : null,
      landingBaseUrl: this.config.invites.landingBaseUrl,
      issuedByUserId: user.id,
    });
    this.logger.warn(
      `Invitation codes issued by ${user.email} — ${codes.length} for “${input.campaign}”, ` +
        `${grantMicros} micro-USD each${expiresAt ? `, expiring ${expiresAt.toISOString()}` : ''}.`,
    );
    return { campaign: input.campaign, grantMicros: String(grantMicros), expiresAt, codes };
  }

  /**
   * Withdraws one code by its row id, through the same service as the CLI's
   * `disable` — and only while it has a seat left: a spent code has nothing to
   * stop, and withdrawing it would only blur what "withdrawn" counts.
   */
  @Mutation(() => InviteWithdrawalModel, {
    description: 'Withdraws one unredeemed invitation code. Restricted to auth.adminEmails.',
  })
  async withdrawInviteCode(
    @CurrentUser() user: SessionUser,
    @Args() args: WithdrawInviteCodeArgs,
  ): Promise<InviteWithdrawalModel> {
    const result = await this.withdrawals.withdraw({ id: args.id, unspentOnly: true });
    this.logger.warn(`Invitation code withdrawn by ${user.email} — ${describeWithdrawal(result)}`);
    return result;
  }

  private codeOf(code: AdminInviteCode): AdminInviteCodeModel {
    return {
      id: code.id,
      code: formatInviteCode(code.code),
      url: inviteUrl({ landingBaseUrl: this.config.invites.landingBaseUrl, campaign: code.campaign, code: code.code }),
      campaign: code.campaign,
      grantMicros: String(code.grantMicros),
      maxRedemptions: code.maxRedemptions,
      redemptionCount: code.redemptionCount,
      status: code.status.toUpperCase() as InviteCodeStatusEnum,
      createdAt: code.createdAt,
      expiresAt: code.expiresAt,
      withdrawnAt: code.disabledAt,
      note: code.note,
      issuedByEmail: code.issuedByEmail,
      redeemers: code.redeemers,
    };
  }
}

function signUpOf(signUp: AdminSignUp): AdminSignUpModel {
  return {
    userId: signUp.userId,
    email: signUp.email,
    createdAt: signUp.createdAt,
    origin: signUp.origin.toUpperCase() as SignUpOriginEnum,
    inviteCodeId: signUp.invite?.inviteCodeId ?? null,
    inviteCode: signUp.invite ? formatInviteCode(signUp.invite.code) : null,
    campaign: signUp.invite?.campaign ?? null,
    redeemedAt: signUp.invite?.redeemedAt ?? null,
  };
}
