import { Field, Float, GraphQLISODateTime, ID, Int, ObjectType } from '@nestjs/graphql';

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
