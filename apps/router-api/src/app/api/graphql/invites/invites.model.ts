import { Field, Float, GraphQLISODateTime, ID, Int, ObjectType, registerEnumType } from '@nestjs/graphql';

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
