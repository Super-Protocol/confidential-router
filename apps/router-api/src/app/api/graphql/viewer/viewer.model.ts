import { Field, ID, InputType, ObjectType, registerEnumType } from '@nestjs/graphql';
import { IsString, Length, Matches, MaxLength } from 'class-validator';
import type { WorkspaceRole } from '../../../db/entities/workspace-member.entity.js';

/** Runtime twin of `WorkspaceRole`; the values are what the membership table holds. */
export const WorkspaceRoleEnum = {
  OWNER: 'owner',
  MEMBER: 'member',
} as const satisfies Record<string, WorkspaceRole>;

registerEnumType(WorkspaceRoleEnum, {
  name: 'WorkspaceRole',
  description: 'An owner may spend the workspace’s credits; a member may only use them.',
});

@ObjectType('Workspace', { description: 'A workspace the viewer belongs to.' })
export class WorkspaceModel {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field()
  slug!: string;

  @Field(() => WorkspaceRoleEnum, { description: 'The role the viewer holds here.' })
  role!: WorkspaceRole;

  @Field(() => String, {
    description: 'Credit balance in micro-USD, as a string so no precision is lost in JSON.',
  })
  balanceMicros!: string;
}

@ObjectType('User', { description: 'The signed-in console user.' })
export class ViewerModel {
  @Field(() => ID)
  id!: string;

  @Field()
  email!: string;

  @Field(() => String, { nullable: true })
  name!: string | null;

  @Field(() => String, { nullable: true, description: 'Profile picture from the OAuth provider, when there is one.' })
  avatarUrl!: string | null;

  @Field(() => Boolean, {
    description:
      'Whether this address is in `auth.adminEmails` — the one question the browser could not ask before ' +
      'ADR-008 §7. It gates the admin section’s nav entry; it is not itself a permission, because every ' +
      'operator-only operation is behind `AdminGuard` whatever a client believes.',
  })
  isAdmin!: boolean;

  @Field(() => [WorkspaceModel], { description: 'Every workspace the viewer is a member of, oldest first.' })
  workspaces!: WorkspaceModel[];
}

@InputType('UpdateProfileInput')
export class UpdateProfileInput {
  @Field(() => String, { description: 'The display name shown in the console. Blank is not a name.' })
  @IsString()
  @Length(1, 255)
  // `@Length` alone would accept three spaces, which the resolver then trims
  // into the empty name this field exists to prevent.
  @Matches(/\S/, { message: 'name must not be blank.' })
  name!: string;
}

@InputType('SetPasswordInput')
export class SetPasswordInput {
  @Field(() => String, {
    description: 'The password to sign in with. `auth.password.minLength` is enforced by the router, not here.',
  })
  @IsString()
  // Better Auth's own ceiling; the minimum is deployment configuration and is
  // checked where it lives.
  @MaxLength(128)
  password!: string;
}
