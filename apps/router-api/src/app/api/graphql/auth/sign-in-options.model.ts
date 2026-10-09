import { Field, Int, ObjectType } from '@nestjs/graphql';

@ObjectType('SignInOptions', { description: 'Which sign-in paths this deployment offers.' })
export class SignInOptionsModel {
  @Field({
    description:
      'A bootstrap token can create the first account right now: one is configured and the deployment has no ' +
      'user yet. False on every deployment that has already been signed into.',
  })
  bootstrap!: boolean;

  @Field({ description: 'A GitHub OAuth app is configured.' })
  github!: boolean;

  @Field({ description: 'A Google OAuth app is configured.' })
  google!: boolean;

  @Field({ description: 'A mailer is configured, so a one-time link can be sent.' })
  magicLink!: boolean;

  @Field({
    description:
      'Email and password sign-in and sign-up are enabled. There is no email verification; password reset ' +
      'is offered only where `passwordReset` says so.',
  })
  password!: boolean;

  @Field({
    description:
      'A forgotten password can be reset by mail: passwords are enabled and the deployment has a mailer. ' +
      'While false the reset endpoints answer 404 and the console offers no "Forgot password?" link.',
  })
  passwordReset!: boolean;

  @Field(() => Int, {
    description:
      'The shortest password this deployment accepts, so the sign-up form can state the rule instead of ' +
      'discovering it. Meaningless while `password` is false.',
  })
  passwordMinLength!: number;

  @Field({
    description:
      'Registration is by invitation: no sign-up path on this deployment creates an account without an ' +
      'invitation code that is valid and unredeemed. Signing in to an existing account is unaffected.',
  })
  inviteRequired!: boolean;
}
