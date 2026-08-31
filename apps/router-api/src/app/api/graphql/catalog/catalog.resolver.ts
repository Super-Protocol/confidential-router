import { UseGuards } from '@nestjs/common';
import { Args, ID, Query, Resolver } from '@nestjs/graphql';
import {
  CurrentUser,
  OptionalSessionGuard,
  SessionGuard,
  type SessionUser,
  WorkspaceScopeService,
} from '../../../auth/index.js';
import { CatalogViewService } from './catalog-view.service.js';
import { EndpointModel } from './endpoint.model.js';
import { LlmModel } from './model.model.js';

/**
 * The Models and Overview screens: what this router can route to, and where.
 *
 * Both lists are projections of the router config (ADR-002) — there is no
 * mutation here, because a model or an endpoint is not something a console user
 * creates.
 *
 * `models` and `model` are the only public operations in this schema. A router
 * that meters LLM traffic has to be able to say what it routes to, and at what
 * price, before anyone signs up; everything else is behind `SessionGuard`.
 */
@Resolver(() => LlmModel)
export class CatalogResolver {
  constructor(
    private readonly view: CatalogViewService,
    private readonly workspaces: WorkspaceScopeService,
  ) {}

  @Query(() => [LlmModel], { name: 'models', description: 'Routable models, in config order. Public.' })
  @UseGuards(OptionalSessionGuard)
  async models(
    @CurrentUser() user: SessionUser | undefined,
    @Args('tee', { nullable: true, description: 'Narrow to one TEE label.' }) tee?: string,
  ): Promise<LlmModel[]> {
    return this.view.modelViews(await this.defaultWorkspaceId(user), tee);
  }

  @Query(() => LlmModel, { name: 'model', nullable: true, description: 'One routable model, by id. Public.' })
  @UseGuards(OptionalSessionGuard)
  async model(
    @CurrentUser() user: SessionUser | undefined,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<LlmModel | null> {
    const models = await this.view.modelViews(await this.defaultWorkspaceId(user));
    return models.find((model) => model.id === id) ?? null;
  }

  @Query(() => [EndpointModel], {
    name: 'endpoints',
    description: 'The router hostnames the platform publishes evidence for, with what each currently publishes.',
  })
  @UseGuards(SessionGuard)
  async endpoints(
    @CurrentUser() user: SessionUser,
    @Args('workspaceId', { type: () => ID }) workspaceId: string,
  ): Promise<EndpointModel[]> {
    const workspace = await this.workspaces.requireMembership(user.id, workspaceId);
    return this.view.endpointViews(workspace.id);
  }

  /**
   * The catalogue is the same for everyone, but the endpoint each model hangs
   * off carries the viewer's own usage — so it is resolved against the
   * workspace the console opens on, and against none at all for the anonymous
   * caller the public listing exists for.
   */
  private async defaultWorkspaceId(user: SessionUser | undefined): Promise<string | null> {
    if (!user) {
      return null;
    }
    const workspace = await this.workspaces.defaultForUser(user.id);
    return workspace?.id ?? null;
  }
}
