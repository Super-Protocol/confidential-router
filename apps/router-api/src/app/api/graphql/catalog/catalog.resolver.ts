import { UseGuards } from '@nestjs/common';
import { Args, ID, Query, Resolver } from '@nestjs/graphql';
import { CurrentUser, SessionGuard, type SessionUser, WorkspaceScopeService } from '../../../auth/index.js';
import { CatalogViewService } from './catalog-view.service.js';
import { EndpointModel } from './endpoint.model.js';
import { LlmModel } from './model.model.js';

/**
 * The Models and Overview screens: what this router can route to, and where.
 *
 * Both lists are projections of the router config (ADR-002) — there is no
 * mutation here, because a model or an endpoint is not something a console user
 * creates.
 */
@Resolver(() => LlmModel)
@UseGuards(SessionGuard)
export class CatalogResolver {
  constructor(
    private readonly view: CatalogViewService,
    private readonly workspaces: WorkspaceScopeService,
  ) {}

  @Query(() => [LlmModel], { name: 'models', description: 'Routable models, in config order.' })
  async models(
    @CurrentUser() user: SessionUser,
    @Args('tee', { nullable: true, description: 'Narrow to one TEE label.' }) tee?: string,
  ): Promise<LlmModel[]> {
    return this.view.modelViews(await this.defaultWorkspaceId(user), tee);
  }

  @Query(() => LlmModel, { name: 'model', nullable: true })
  async model(@CurrentUser() user: SessionUser, @Args('id', { type: () => ID }) id: string): Promise<LlmModel | null> {
    const models = await this.view.modelViews(await this.defaultWorkspaceId(user));
    return models.find((model) => model.id === id) ?? null;
  }

  @Query(() => [EndpointModel], {
    name: 'endpoints',
    description: 'The router hostnames the platform publishes evidence for, with what each currently publishes.',
  })
  async endpoints(
    @CurrentUser() user: SessionUser,
    @Args('workspaceId', { type: () => ID }) workspaceId: string,
  ): Promise<EndpointModel[]> {
    const workspace = await this.workspaces.requireMembership(user.id, workspaceId);
    return this.view.endpointViews(workspace.id);
  }

  /**
   * `models` is not workspace-scoped — the catalogue is the same for everyone —
   * but the endpoint it hangs off carries the viewer's own usage, so it is
   * resolved against the workspace the console opens on.
   */
  private async defaultWorkspaceId(user: SessionUser): Promise<string | null> {
    const workspace = await this.workspaces.defaultForUser(user.id);
    return workspace?.id ?? null;
  }
}
