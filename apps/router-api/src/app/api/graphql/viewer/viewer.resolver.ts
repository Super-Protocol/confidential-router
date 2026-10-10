import { Inject, UseGuards } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Args, GraphQLISODateTime, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import {
  type AuthenticatedRequest,
  CurrentUser,
  isAdminEmail,
  SessionGuard,
  type SessionUser,
  UserProfileService,
  WorkspaceScopeService,
} from '../../../auth/index.js';
import { routerConfig } from '../../../config.js';
import { PreferencesService } from '../../../preferences/index.js';
import { GqlRequest } from '../common/gql-request.decorator.js';
import { preferencesModel, UserPreferencesModel } from '../preferences/preferences.model.js';
import { UpdateProfileInput, ViewerModel } from './viewer.model.js';

/**
 * The viewer: who is signed in, where they may act, and what they have set.
 *
 * `me` is the console's first call on every page load, so the fields a screen
 * always needs travel with it and the ones only one screen needs — `createdAt`
 * on Profile, `preferences` on Preferences — are resolved on demand rather than
 * costing every page load a join.
 */
@Resolver(() => ViewerModel)
@UseGuards(SessionGuard)
export class ViewerResolver {
  // biome-ignore lint/complexity/useMaxParams: a Nest DI constructor has no call site to keep readable.
  constructor(
    private readonly workspaces: WorkspaceScopeService,
    // Not `preferences`: that name is taken by the field resolver below, and a
    // constructor property would shadow the prototype method.
    private readonly settings: PreferencesService,
    private readonly profiles: UserProfileService,
    @Inject(routerConfig.KEY) private readonly config: ConfigType<typeof routerConfig>,
  ) {}

  /**
   * Who am I, and which workspaces may I act in. Everything workspace-scoped
   * downstream is checked against this same membership table, never against an
   * id the client sends unverified.
   */
  @Query(() => ViewerModel, { name: 'me', description: 'The signed-in user, or an error when anonymous.' })
  async me(@CurrentUser() user: SessionUser): Promise<ViewerModel> {
    return this.viewerModel(user);
  }

  @ResolveField(() => GraphQLISODateTime, {
    description: 'When the account was created — “member since” on the Profile screen.',
  })
  async createdAt(@Parent() viewer: ViewerModel): Promise<Date> {
    return (await this.profiles.require(viewer.id)).createdAt;
  }

  @ResolveField(() => UserPreferencesModel, { description: 'The viewer’s console settings.' })
  async preferences(@Parent() viewer: ViewerModel): Promise<UserPreferencesModel> {
    return preferencesModel(await this.settings.get(viewer.id));
  }

  /**
   * Renames the account. The request goes through rather than a user id — see
   * `UserProfileService.rename` for why.
   */
  @Mutation(() => ViewerModel, { description: 'Changes the viewer’s display name.' })
  async updateProfile(
    @GqlRequest() request: AuthenticatedRequest,
    @Args('input') input: UpdateProfileInput,
  ): Promise<ViewerModel> {
    return this.viewerModel(await this.profiles.rename(request.headers, input.name));
  }

  private async viewerModel(user: SessionUser): Promise<ViewerModel> {
    const memberships = await this.workspaces.listForUser(user.id);
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.image,
      // Computed here rather than resolved on demand: it is a string comparison
      // against config, and the console needs it on the first call of every page
      // load to decide whether the admin nav entry exists at all.
      isAdmin: isAdminEmail(user.email, this.config.auth.adminEmails),
      workspaces: memberships.map(({ workspace, role }) => ({
        id: workspace.id,
        name: workspace.name,
        slug: workspace.slug,
        role,
        balanceMicros: String(workspace.balanceMicros),
      })),
    };
  }
}
