import { Field, GraphQLISODateTime, ID, ObjectType, registerEnumType } from '@nestjs/graphql';

/**
 * Why the offer is not being made.
 *
 * The console shows a different thing for each: nothing at all for an account
 * that has credit left, and the grant itself for one that has already taken it.
 * Collapsing them into a bare `false` would leave the browser guessing, and a
 * browser guessing about eligibility is the thing this feature must not do.
 */
export enum FeedbackIneligibleReasonEnum {
  DISABLED = 'disabled',
  NO_FIRST_GRANT = 'no_first_grant',
  ALREADY_GRANTED = 'already_granted',
  BALANCE_HEALTHY = 'balance_healthy',
  NO_USAGE = 'no_usage',
}

registerEnumType(FeedbackIneligibleReasonEnum, { name: 'FeedbackIneligibleReason' });

@ObjectType('FeedbackGrant', { description: 'The second grant an account earned by giving feedback.' })
export class FeedbackGrantModel {
  @Field(() => ID, { description: 'The `grant` ledger entry this submission wrote.' })
  creditTransactionId!: string;

  @Field(() => String, { description: 'Micro-USD credited.' })
  grantMicros!: string;

  @Field(() => GraphQLISODateTime)
  appliedAt!: Date;
}

@ObjectType('FeedbackOffer', { description: 'Whether to ask this account for feedback, and where to send it.' })
export class FeedbackOfferModel {
  @Field(() => Boolean, { description: 'Whether the second grant is available to the viewer right now.' })
  eligible!: boolean;

  @Field(() => FeedbackIneligibleReasonEnum, {
    nullable: true,
    description: 'Why not. Null when `eligible`.',
  })
  reason!: FeedbackIneligibleReasonEnum | null;

  @Field(() => String, { description: 'Micro-USD a completed form credits.' })
  grantMicros!: string;

  @Field(() => String, {
    nullable: true,
    description:
      'The form, with a short-lived signed token in its hidden fields. Null unless eligible; ' +
      'it expires in minutes, so it is read when the offer is shown and not stored.',
  })
  formUrl!: string | null;

  @Field(() => FeedbackGrantModel, {
    nullable: true,
    description: 'The grant already applied to this account, if there is one.',
  })
  granted!: FeedbackGrantModel | null;
}
