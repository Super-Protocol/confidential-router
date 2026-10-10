import {
  ArgsType,
  Field,
  Float,
  GraphQLISODateTime,
  ID,
  InputType,
  Int,
  ObjectType,
  registerEnumType,
} from '@nestjs/graphql';
import {
  IsDate,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumberString,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { INVITE_CAMPAIGN_PATTERN } from '../../../invites/invite-code.js';
import { InviteCampaignStatsModel } from './invites.model.js';

/*
 * The admin console's Invitations section (SUP-268). Every type here is behind
 * `auth.adminEmails`; the resolver is where that is enforced.
 */

export enum InviteCodeStatusEnum {
  /** Has a seat left and can still be redeemed. */
  ACTIVE = 'ACTIVE',
  /** Every seat is taken. */
  REDEEMED = 'REDEEMED',
  /** Past its expiry with a seat left. */
  EXPIRED = 'EXPIRED',
  /** An operator withdrew it. Takes precedence over every other status. */
  WITHDRAWN = 'WITHDRAWN',
}

registerEnumType(InviteCodeStatusEnum, {
  name: 'InviteCodeStatus',
  description: 'Where an invitation code stands. A withdrawn code reads as withdrawn whatever else is true of it.',
});

export enum SignUpOriginEnum {
  /** Redeemed an invitation code when the account was created. */
  INVITE = 'INVITE',
  /** The first account, created with the deployment’s bootstrap token. */
  BOOTSTRAP = 'BOOTSTRAP',
  /** Signed up without a code — only possible while registration is open. */
  OPEN = 'OPEN',
}

registerEnumType(SignUpOriginEnum, { name: 'SignUpOrigin', description: 'How an account came to exist.' });

@ObjectType('InviteCodeRedeemer')
export class InviteCodeRedeemerModel {
  @Field(() => ID)
  userId!: string;

  @Field(() => String, { nullable: true, description: 'Null when the account no longer exists.' })
  email!: string | null;

  @Field(() => GraphQLISODateTime)
  redeemedAt!: Date;
}

@ObjectType('AdminInviteCode', { description: 'One invitation code, as an operator sees it.' })
export class AdminInviteCodeModel {
  @Field(() => ID)
  id!: string;

  @Field(() => String, { description: 'Display form, `ABCD-EFGH-JKMN`. The console masks it until asked.' })
  code!: string;

  @Field(() => String, { description: 'The invitation link, on `invites.landingBaseUrl`.' })
  url!: string;

  @Field(() => String)
  campaign!: string;

  @Field(() => String, { description: 'Micro-USD one redemption grants.' })
  grantMicros!: string;

  @Field(() => Int)
  maxRedemptions!: number;

  @Field(() => Int)
  redemptionCount!: number;

  @Field(() => InviteCodeStatusEnum)
  status!: InviteCodeStatusEnum;

  @Field(() => GraphQLISODateTime, { description: 'When the code was issued.' })
  createdAt!: Date;

  @Field(() => GraphQLISODateTime, { nullable: true })
  expiresAt!: Date | null;

  @Field(() => GraphQLISODateTime, { nullable: true })
  withdrawnAt!: Date | null;

  @Field(() => String, { nullable: true })
  note!: string | null;

  @Field(() => String, { nullable: true, description: 'The operator who issued it; null for a CLI-issued code.' })
  issuedByEmail!: string | null;

  @Field(() => [InviteCodeRedeemerModel], { description: 'Accounts that redeemed it, oldest first.' })
  redeemers!: InviteCodeRedeemerModel[];
}

@ObjectType('AdminInviteCodePage')
export class AdminInviteCodePageModel {
  @Field(() => Int, { description: 'Codes matching the filter, across every page.' })
  totalCount!: number;

  @Field(() => [AdminInviteCodeModel])
  nodes!: AdminInviteCodeModel[];
}

@ObjectType('AdminSignUp', { description: 'One account, and how it came to exist.' })
export class AdminSignUpModel {
  @Field(() => ID)
  userId!: string;

  @Field(() => String)
  email!: string;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => SignUpOriginEnum)
  origin!: SignUpOriginEnum;

  @Field(() => ID, { nullable: true, description: 'The code redeemed. Set exactly when `origin` is INVITE.' })
  inviteCodeId!: string | null;

  @Field(() => String, { nullable: true, description: 'Its display form. The console masks it until asked.' })
  inviteCode!: string | null;

  @Field(() => String, { nullable: true })
  campaign!: string | null;

  @Field(() => GraphQLISODateTime, { nullable: true })
  redeemedAt!: Date | null;
}

@ObjectType('AdminSignUpPage')
export class AdminSignUpPageModel {
  @Field(() => Int)
  totalCount!: number;

  @Field(() => [AdminSignUpModel])
  nodes!: AdminSignUpModel[];
}

@ObjectType('InviteTotals', { description: 'Deployment-wide invitation numbers.' })
export class InviteTotalsModel {
  @Field(() => Int, { description: 'Codes ever issued.' })
  issued!: number;

  @Field(() => Int, { description: 'Redemptions — one per invited account.' })
  redeemed!: number;

  @Field(() => Int, { description: 'Codes an operator withdrew.' })
  withdrawn!: number;

  @Field(() => Float, { description: '`redeemed / issued`; 0 when nothing was issued.' })
  redemptionRate!: number;

  @Field(() => String, { description: 'Micro-USD granted through invitations.' })
  grantedMicros!: string;

  @Field(() => Int, { description: 'Accounts on the deployment, however they arrived.' })
  signUps!: number;
}

@ObjectType('InviteDay', { description: 'One UTC day of invitation activity.' })
export class InviteDayModel {
  @Field(() => String, { description: '`YYYY-MM-DD`, UTC.' })
  date!: string;

  @Field(() => Int)
  codesIssued!: number;

  @Field(() => Int)
  codesRedeemed!: number;

  @Field(() => Int)
  signUpsInvited!: number;

  @Field(() => Int)
  signUpsBootstrap!: number;

  @Field(() => Int)
  signUpsOpen!: number;
}

@ObjectType('InviteStatistics', { description: 'Everything the Invitations statistics tab draws, in one round trip.' })
export class InviteStatisticsModel {
  @Field(() => InviteTotalsModel)
  totals!: InviteTotalsModel;

  @Field(() => [InviteDayModel], { description: 'Every day of the window, oldest first; empty days are zeros.' })
  daily!: InviteDayModel[];

  @Field(() => [InviteCampaignStatsModel], { description: 'Per-campaign breakdown, most recently issued first.' })
  campaigns!: InviteCampaignStatsModel[];
}

@ObjectType('IssuedInviteCode')
export class IssuedInviteCodeModel {
  @Field(() => ID)
  id!: string;

  @Field(() => String, { description: 'Display form, `ABCD-EFGH-JKMN`.' })
  code!: string;

  @Field(() => String)
  url!: string;
}

@ObjectType('IssuedInviteCodes', { description: 'A freshly issued batch. The console shows it once.' })
export class IssuedInviteCodesModel {
  @Field(() => String)
  campaign!: string;

  @Field(() => String, { description: 'Micro-USD each code grants.' })
  grantMicros!: string;

  @Field(() => GraphQLISODateTime, { nullable: true })
  expiresAt!: Date | null;

  @Field(() => [IssuedInviteCodeModel])
  codes!: IssuedInviteCodeModel[];
}

/** Codes per call. A launch mailing of thousands is still the CLI's job. */
export const MAX_ISSUE_COUNT = 1000;

/**
 * Credit per code, in micro-USD: $10,000.
 *
 * Not a policy on what a code may be worth — the CLI has no ceiling — but a
 * fat-finger guard on a form where one extra zero mints real money in bulk.
 */
export const MAX_ISSUE_GRANT_MICROS = 10_000_000_000;

@InputType('IssueInviteCodesInput')
export class IssueInviteCodesInputModel {
  @Field(() => Int, { description: `How many codes, 1–${MAX_ISSUE_COUNT}.` })
  @IsInt()
  @Min(1)
  @Max(MAX_ISSUE_COUNT)
  count!: number;

  @Field(() => String, { description: 'Micro-USD each redemption grants, as an integer string.' })
  @IsNumberString({ no_symbols: true })
  grantMicros!: string;

  @Field(() => String, { description: 'Campaign tag: a lowercase slug, e.g. `launch-2026-10-devs`.' })
  @IsString()
  @Matches(INVITE_CAMPAIGN_PATTERN, { message: 'campaign must be a lowercase tag such as "launch-2026-10-devs".' })
  campaign!: string;

  @Field(() => Int, { defaultValue: 1, description: 'Accounts that may redeem each code.' })
  @IsInt()
  @Min(1)
  @Max(10_000)
  maxRedemptions!: number;

  @Field(() => GraphQLISODateTime, { nullable: true, description: 'When the codes stop working. Null: never.' })
  @IsOptional()
  @IsDate()
  expiresAt?: Date | null;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @Length(0, 512)
  note?: string | null;
}

@ArgsType()
export class AdminInviteCodesArgs {
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  campaign?: string;

  @Field(() => InviteCodeStatusEnum, { nullable: true })
  @IsOptional()
  @IsEnum(InviteCodeStatusEnum)
  status?: InviteCodeStatusEnum;

  @Field(() => Int, { defaultValue: 0 })
  @IsInt()
  @Min(0)
  offset!: number;

  @Field(() => Int, { defaultValue: 50 })
  @IsInt()
  @Min(1)
  @Max(200)
  limit!: number;
}

@ArgsType()
export class AdminSignUpsArgs {
  @Field(() => SignUpOriginEnum, { nullable: true })
  @IsOptional()
  @IsEnum(SignUpOriginEnum)
  origin?: SignUpOriginEnum;

  @Field(() => Int, { defaultValue: 0 })
  @IsInt()
  @Min(0)
  offset!: number;

  @Field(() => Int, { defaultValue: 50 })
  @IsInt()
  @Min(1)
  @Max(200)
  limit!: number;
}

@ArgsType()
export class InviteStatisticsArgs {
  @Field(() => Int, { defaultValue: 30, description: 'Days of daily series, ending today (UTC).' })
  @IsInt()
  @Min(1)
  @Max(366)
  days!: number;
}

@ArgsType()
export class WithdrawInviteCodeArgs {
  @Field(() => ID)
  @IsString()
  @IsNotEmpty()
  id!: string;
}
