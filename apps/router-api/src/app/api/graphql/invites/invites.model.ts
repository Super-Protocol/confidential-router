import { Field, Float, GraphQLISODateTime, ID, InputType, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import { IsBoolean, IsOptional, IsString, Length } from 'class-validator';

/**
 * Why an account that presented a code has no grant.
 *
 * The typed reason the anonymous lookup deliberately withholds (`InviteLookupDto`
 * answers one `unavailable` for everything, so it cannot confirm that a guessed
 * code is real). Here the caller is signed in and already holds the code, so
 * there is nothing left to leak and four different messages to write — an expired
 * campaign and a mistyped code want different sentences (SUP-145).
 */
export enum InviteRefusalReason {
  /** No code by that spelling was ever issued — or the string is not a code. */
  NOT_FOUND = 'NOT_FOUND',
  EXPIRED = 'EXPIRED',
  /** Every seat on the code is taken. A single-use code opened twice lands here. */
  EXHAUSTED = 'EXHAUSTED',
  DISABLED = 'DISABLED',
  /**
   * This account already holds an invitation credit. One grant per account, ever
   * — the unique index on `invite_redemptions.userId` is that policy.
   */
  ALREADY_REDEEMED = 'ALREADY_REDEEMED',
  /** The redemption failed for a reason that is ours, not the code's. */
  ERROR = 'ERROR',
}

registerEnumType(InviteRefusalReason, {
  name: 'InviteRefusalReason',
  description: 'Why a presented invitation code did not credit this account.',
});

@ObjectType('InviteGrant', { description: 'The invitation credit an account received, if it received one.' })
export class InviteGrantModel {
  @Field(() => ID, { description: 'The `grant` ledger entry this redemption wrote.' })
  creditTransactionId!: string;

  @Field(() => String, { description: 'Micro-USD credited.' })
  grantMicros!: string;

  @Field(() => String, { description: 'Campaign the code belonged to.' })
  campaign!: string;

  @Field(() => GraphQLISODateTime)
  redeemedAt!: Date;
}

@ObjectType('InviteCampaignStats', { description: 'How one invitation campaign converted. Operators only.' })
export class InviteCampaignStatsModel {
  @Field(() => String)
  campaign!: string;

  @Field(() => Int, { description: 'Codes generated.' })
  issued!: number;

  @Field(() => Int, { description: 'Accounts that redeemed one.' })
  redeemed!: number;

  @Field(() => Float, { description: '`redeemed / issued`; 0 when nothing was issued.' })
  redemptionRate!: number;

  @Field(() => Int, {
    description: 'Redeeming accounts that went on to send at least one request — the number worth reading.',
  })
  activated!: number;

  @Field(() => String, { description: 'Micro-USD handed out so far.' })
  grantedMicros!: string;
}

@ObjectType('InviteGrantStatus', {
  description: 'What became of the invitation code this account signed up with, if it presented one.',
})
export class InviteGrantStatusModel {
  @Field(() => InviteGrantModel, { nullable: true, description: 'The credit, when there is one.' })
  grant!: InviteGrantModel | null;

  @Field(() => InviteRefusalReason, {
    nullable: true,
    description: 'Why no credit was applied. Null when `grant` is set and the code presented was the one redeemed.',
  })
  reason!: InviteRefusalReason | null;
}

/**
 * What a withdrawal did — the four numbers `invites disable` prints, for the
 * operator who has no shell on the cluster to print them in.
 *
 * `matched` is the one to read first: zero means the code or campaign named does
 * not exist, which on a leak is the difference between "closed" and "still open
 * and you have a typo".
 */
@ObjectType('InviteWithdrawal', { description: 'How many invitation codes an operator withdrew. Operators only.' })
export class InviteWithdrawalModel {
  @Field(() => String, { description: 'The code or campaign acted on, echoed back normalised.' })
  target!: string;

  @Field(() => Int, { description: 'Codes the target matched. Zero means there is no such code or campaign.' })
  matched!: number;

  @Field(() => Int, { description: 'Codes this call withdrew. No further sign-up can redeem them.' })
  withdrawn!: number;

  @Field(() => Int, { description: 'Codes already withdrawn before this call; their timestamps were left alone.' })
  alreadyWithdrawn!: number;

  @Field(() => Int, { description: 'Codes left in circulation because every seat is spent — `unspentOnly` only.' })
  spent!: number;
}

@ObjectType('InviteRestoration', {
  description: 'How many withdrawn invitation codes an operator put back. Operators only.',
})
export class InviteRestorationModel {
  @Field(() => String)
  target!: string;

  @Field(() => Int)
  matched!: number;

  @Field(() => Int, { description: 'Codes this call put back into circulation.' })
  restored!: number;

  @Field(() => Int, { description: 'Codes the target matched that were never withdrawn.' })
  alreadyUsable!: number;
}

/**
 * Which codes an operator is acting on. Exactly one of the two, checked
 * server-side: a mutation that took both would have to guess which the operator
 * meant, and this one retires a mailing.
 */
@InputType('RestoreInviteCodesInput')
export class RestoreInviteCodesInputModel {
  @Field(() => String, { nullable: true, description: 'One code, in any spelling.' })
  @IsOptional()
  @IsString()
  @Length(1, 32)
  code?: string;

  @Field(() => String, { nullable: true, description: 'Every code of one campaign.' })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  campaign?: string;
}

@InputType('DisableInviteCodesInput')
export class DisableInviteCodesInputModel extends RestoreInviteCodesInputModel {
  @Field(() => Boolean, {
    nullable: true,
    defaultValue: false,
    description: 'Leave codes whose every seat is already taken alone.',
  })
  @IsOptional()
  @IsBoolean()
  unspentOnly?: boolean;
}
