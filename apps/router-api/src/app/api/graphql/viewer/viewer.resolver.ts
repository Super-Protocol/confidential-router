import { UseGuards } from '@nestjs/common';
import { Query, Resolver } from '@nestjs/graphql';
import { CurrentUser, SessionGuard, type SessionUser, WorkspaceScopeService } from '../../../auth/index.js';
import { ViewerModel } from './viewer.model.js';

@Resolver(() => ViewerModel)
export class ViewerResolver {
  constructor(private readonly workspaces: WorkspaceScopeService) {}

  /**
   * The console's first call on every page load: who am I, and which workspaces
   * may I act in. Everything workspace-scoped downstream is checked against this
   * same membership table, never against an id the client sends unverified.
   */
  @Query(() => ViewerModel, { name: 'me', description: 'The signed-in user, or an error when anonymous.' })
  @UseGuards(SessionGuard)
  async me(@CurrentUser() user: SessionUser): Promise<ViewerModel> {
    const memberships = await this.workspaces.listForUser(user.id);
    return {
      ...user,
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
