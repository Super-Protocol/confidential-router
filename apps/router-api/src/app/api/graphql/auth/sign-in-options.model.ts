import { Field, ObjectType } from '@nestjs/graphql';

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
}
