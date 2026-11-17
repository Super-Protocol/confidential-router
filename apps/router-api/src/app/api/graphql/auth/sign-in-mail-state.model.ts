import { Field, ObjectType, registerEnumType } from '@nestjs/graphql';

/**
 * What the mail provider has said about one address.
 *
 * `UNKNOWN` is the answer for almost every address, including every address
 * nobody has ever mailed. The one value that changes what a screen says is
 * `REJECTING`.
 */
export enum SignInMailStateName {
  /** Nothing has gone wrong with mail to this address. */
  UNKNOWN = 'UNKNOWN',
  /** Mail to it is being dropped and will keep being dropped. */
  REJECTING = 'REJECTING',
  /** Something non-permanent went wrong; the provider will retry. */
  DELAYED = 'DELAYED',
  /** The last message to it arrived. */
  DELIVERING = 'DELIVERING',
}

registerEnumType(SignInMailStateName, {
  name: 'SignInMailStateName',
  description: 'What this deployment’s mail provider last reported about an address.',
});

@ObjectType('SignInMailState', { description: 'Whether a sign-in code can reach an address at all.' })
export class SignInMailStateModel {
  @Field(() => SignInMailStateName)
  state!: SignInMailStateName;

  @Field({
    nullable: true,
    description: 'When the current state began, as an ISO timestamp. Null while the state is UNKNOWN.',
  })
  since?: string;
}
