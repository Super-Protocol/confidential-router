import { BadRequestException, ConflictException, UseGuards } from '@nestjs/common';
import { Args, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { AnalyticsService, eventUuid } from '../../../analytics/index.js';
import { AdminGuard, CurrentUser, SessionGuard, type SessionUser, WorkspaceScopeService } from '../../../auth/index.js';
import type { ModelRequest, ModelRequestSource } from '../../../db/entities/model-request.entity.js';
import { MAX_DEMAND_ROWS, ModelRequestsService } from '../../../model-requests/index.js';
import {
  ModelDemandModel,
  ModelRequestReceiptModel,
  ModelRequestSourceEnum,
  RequestModelInputModel,
} from './model-request.model.js';

/** The SDL's spelling of a source, and the taxonomy's. See `ModelRequestSourceEnum`. */
const SOURCES: Record<ModelRequestSourceEnum, ModelRequestSource> = {
  [ModelRequestSourceEnum.MODELS_PAGE]: 'models_page',
  [ModelRequestSourceEnum.EMPTY_STATE]: 'empty_state',
  [ModelRequestSourceEnum.DASHBOARD]: 'dashboard',
};

/**
 * "Request a model": the one write a visitor makes to the catalogue, and the
 * demand it adds up to.
 *
 * The mutation takes no workspace id. Unlike a key or a generation, a request
 * is not a thing anybody owns — it is filed by an account, and the workspace is
 * recorded only so the row can be joined to usage later. Letting the caller
 * name one would be offering a choice that changes nothing and can be got
 * wrong, so the session's own workspace is used, as `feedbackOffer` does.
 */
@Resolver()
export class ModelRequestsResolver {
  constructor(
    private readonly requests: ModelRequestsService,
    private readonly workspaces: WorkspaceScopeService,
    private readonly analytics: AnalyticsService,
  ) {}

  @Mutation(() => ModelRequestReceiptModel, {
    description: 'Asks us to serve a model. Rate-limited per account; there is deliberately no deduplication.',
  })
  @UseGuards(SessionGuard)
  async requestModel(
    @CurrentUser() user: SessionUser,
    @Args('input') input: RequestModelInputModel,
  ): Promise<ModelRequestReceiptModel> {
    const workspace = await this.workspaces.defaultForUser(user.id);
    if (!workspace) {
      // Sign-up provisions one, so this is a broken account rather than a
      // choice the caller made — but the row has a foreign key and cannot be
      // written without it.
      throw new ConflictException('This account has no workspace to file a model request against.');
    }

    const recorded = await this.requests.record({
      userId: user.id,
      workspaceId: workspace.id,
      requestedModel: input.model,
      note: input.note ?? null,
      notify: input.notify ?? false,
      source: SOURCES[input.source],
    });

    await this.report(recorded, user.id);

    return {
      id: recorded.id,
      requestedModel: recorded.requestedModel,
      notify: recorded.notify,
      createdAt: recorded.createdAt,
    };
  }

  /** Demand by model. `auth.adminEmails` only — see `AdminGuard`. */
  @Query(() => [ModelDemandModel], {
    description: 'What people have asked us to serve, most requested first. Restricted to auth.adminEmails.',
  })
  @UseGuards(SessionGuard, AdminGuard)
  async modelDemand(
    @Args('since', { type: () => Date, nullable: true, description: 'Only requests filed at or after this instant.' })
    since?: Date,
    @Args('limit', { type: () => Int, nullable: true, description: 'Cap the list. Omit for every model asked for.' })
    limit?: number,
  ): Promise<ModelDemandModel[]> {
    // A scalar `@Args` misses the global `ValidationPipe`'s class-validator
    // pass, so the bound is checked here. `LIMIT -1` is "no limit" on SQLite
    // and a syntax error on PostgreSQL, which is the worst kind of difference
    // between the test database and the real one.
    if (limit != null && (!Number.isInteger(limit) || limit < 1 || limit > MAX_DEMAND_ROWS)) {
      throw new BadRequestException(`limit must be a whole number between 1 and ${MAX_DEMAND_ROWS}.`);
    }

    const demand = await this.requests.demand({ since: since ?? null, limit: limit ?? null });
    return demand.map((entry) => ({ ...entry, model: entry.requestedModel }));
  }

  /**
   * `model_requested`, after the row is committed.
   *
   * Neither the name asked for nor the note is a property, and that is the
   * taxonomy's decision, not an omission (`schemas/analytics-taxonomy.json`):
   * free text is a breakdown with one row per request, and the note is the one
   * field on either surface where somebody could type something personal. What
   * the funnel gets is the screen it came from and whether the field earned its
   * place; what the model name is, the admin aggregation answers from the
   * database.
   */
  private async report(recorded: ModelRequest, userId: string): Promise<void> {
    await this.analytics.capture({
      event: 'model_requested',
      distinctId: userId,
      uuid: eventUuid('model_requested', recorded.id),
      timestamp: recorded.createdAt,
      properties: { source: recorded.source, has_details: recorded.note !== null },
    });
  }
}
