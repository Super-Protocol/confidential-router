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
      'Email and password sign-in and sign-up are enabled. There is no email verification and no ' +
      'password reset: this path exists for deployments with no mail delivery at all.',
  })
  password!: boolean;

  @Field(() => Int, {
    description:
      'The shortest password this deployment accepts, so the sign-up form can state the rule instead of ' +
      'discovering it. Meaningless while `password` is false.',
  })
  passwordMinLength!: number;
}
