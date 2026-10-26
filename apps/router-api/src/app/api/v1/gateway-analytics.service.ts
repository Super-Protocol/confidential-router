import { Injectable, Logger } from '@nestjs/common';
import { AnalyticsService, eventUuid } from '../../analytics/index.js';
import { WorkspaceOwnerService } from '../../metering/workspace-owner.service.js';
import type { RouteKind } from './gateway.types.js';
import type { ModelDemandResult } from './model-demand.js';

/**
 * What `/v1` reports to product analytics — `model_requested`, SUP-542.
 *
 * The event the first invitation batch needs and the router did not have: which
 * model people ask for, how often, and whether anyone asks for one we do not
 * serve. The taxonomy had the name pointed at a console form (`requestModel`,
 * SUP-146) that was never built, so nothing was ever emitted; this is the same
 * question answered where the answer actually is.
 *
 * Three properties the callers depend on:
 *
 * - **It never throws and is never awaited by the request.** A request that was
 *   served must not become a 500 because PostHog is slow, and a request that was
 *   refused must not be answered more slowly because of a chart.
 * - **It reports the refusals, not only the successes.** `unknown_model` is the
 *   whole roadmap signal; an event emitted only on the success path would answer
 *   "which of our models is popular" and nothing about demand we are missing.
 * - **It reads one field of the body.** `model`, and nothing else — see
 *   `model-demand.ts`, which has access to nothing else.
 */
@Injectable()
export class GatewayAnalytics {
  private readonly logger = new Logger(GatewayAnalytics.name);

  constructor(
    private readonly analytics: AnalyticsService,
    private readonly owners: WorkspaceOwnerService,
  ) {}

  /**
   * Reports one request's model demand. Fire-and-forget: call it with `void`.
   *
   * Identified on the workspace's owner, like `first_request_sent` — one id space
   * for every event about an account, because two would show one person as two in
   * PostHog. The lookup is cached per workspace
   * ({@link WorkspaceOwnerService}), so the per-request cost is a map read.
   *
   * A workspace whose owner cannot be resolved is reported anonymously rather
   * than dropped: the volume and the model are the point, and a random
   * `distinct_id` is what the taxonomy already does for an event with no account
   * behind it.
   */
  async modelRequested(input: {
    workspaceId: string;
    generationId: string;
    modelSlug: string;
    result: ModelDemandResult;
    route: RouteKind;
    at: Date;
  }): Promise<void> {
    try {
      await this.analytics.capture({
        event: 'model_requested',
        distinctId: await this.owners.ownerOf(input.workspaceId),
        // Keyed on the generation id, so a retry inside the analytics client
        // cannot turn one request into two rows of demand.
        uuid: eventUuid('model_requested', input.generationId),
        timestamp: input.at,
        properties: {
          model_slug: input.modelSlug,
          result: input.result,
          route: input.route,
        },
      });
    } catch (error) {
      // `capture` swallows its own failures; this covers the owner lookup, which
      // touches the database and must not be able to reject into a void call.
      this.logger.warn(`Could not report model_requested: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
