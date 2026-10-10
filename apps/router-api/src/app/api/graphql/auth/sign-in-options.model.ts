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

  @Field({
    description:
      'The bootstrap token can sign its own account back in: a token is configured and the account it ' +
      'created exists. The administrator’s way in when no code can be mailed.',
  })
  adminRecovery!: boolean;

  @Field({
    description:
      'A mailer is configured, so a one-time sign-in code can be mailed. This is how accounts sign in and ' +
      'how they are created; there are no passwords.',
  })
  emailCode!: boolean;

  @Field(() => Int, { description: 'How many digits a sign-in code has. Meaningless while `emailCode` is false.' })
  emailCodeLength!: number;

  @Field({ description: 'A one-time sign-in link can be mailed as well as a code.' })
  magicLink!: boolean;

  @Field({
    description:
      'Registration is by invitation: no sign-up path on this deployment creates an account without an ' +
      'invitation code that is valid and unredeemed. Signing in to an existing account is unaffected.',
  })
  inviteRequired!: boolean;
}
