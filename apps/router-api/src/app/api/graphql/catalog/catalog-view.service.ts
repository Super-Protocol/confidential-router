import { Injectable } from '@nestjs/common';
import type { CatalogModel } from '../../../catalog/catalog.service.js';
import { CatalogService } from '../../../catalog/catalog.service.js';
import { EvidenceCoverageStatsService, EvidenceService } from '../../../evidence/index.js';
import { EndpointModel } from './endpoint.model.js';
import { EvidenceSnapshotModel } from './evidence.model.js';
import { LlmModel } from './model.model.js';

/** The window the endpoint table's "tokens routed" column covers. */
const USAGE_WINDOW_DAYS = 30;

/**
 * Assembles the console's view of the catalogue: the config's endpoints and
 * models, joined with what each endpoint currently publishes and how much the
 * viewer's workspace routed through it.
 *
 * It sits between the resolvers and the services so that both the Models screen
 * and the Overview table get the same object, built the same way — including the
 * evidence state, whose three values are the only thing this product is allowed
 * to say about a bundle (ADR-002).
 */
@Injectable()
export class CatalogViewService {
  constructor(
    private readonly catalog: CatalogService,
    private readonly evidence: EvidenceService,
    private readonly coverage: EvidenceCoverageStatsService,
  ) {}

  /**
   * @param workspaceId the workspace whose usage the `tokensRouted30d` column
   *   reports, or null when the caller has no workspace context (then it is 0 —
   *   the endpoints themselves are workspace-independent, only the usage is not).
   */
  async endpointViews(workspaceId: string | null, now: Date = new Date()): Promise<EndpointModel[]> {
    const endpoints = await this.evidence.activeEndpoints();
    const ids = endpoints.map((endpoint) => endpoint.id);
    const [latest, tokens] = await Promise.all([
      this.evidence.latestForMany(ids),
      workspaceId
        ? this.coverage.tokensByEndpoint({
            workspaceId,
            from: new Date(now.getTime() - USAGE_WINDOW_DAYS * 24 * 60 * 60 * 1000),
            to: now,
          })
        : Promise.resolve(new Map<string, number>()),
    ]);

    return endpoints.map((endpoint) => {
      const snapshot = latest.get(endpoint.id) ?? null;
      return {
        id: endpoint.id,
        name: endpoint.name,
        hostname: endpoint.hostname,
        tee: endpoint.tee,
        latestEvidence: snapshot ? EvidenceSnapshotModel.from(snapshot, now) : null,
        evidenceState: this.evidence.stateOfSnapshot(snapshot, now),
        tokensRouted30d: tokens.get(endpoint.id) ?? 0,
      };
    });
  }

  /** Models in config order, optionally narrowed to one TEE label. */
  async modelViews(workspaceId: string | null, tee?: string | null, now: Date = new Date()): Promise<LlmModel[]> {
    const endpoints = new Map((await this.endpointViews(workspaceId, now)).map((view) => [view.id, view]));
    return this.catalog
      .list()
      .filter((model) => !tee || model.endpoint.tee === tee)
      .flatMap((model) => {
        const endpoint = endpoints.get(model.endpoint.id);
        // A model whose endpoint is not in the active set cannot be routed to,
        // so listing it would offer the console something it cannot use.
        return endpoint ? [toModelView(model, endpoint)] : [];
      });
  }
}

function toModelView(model: CatalogModel, endpoint: EndpointModel): LlmModel {
  return {
    id: model.id,
    slug: model.id,
    name: model.name,
    contextLength: model.contextLength,
    capabilities: model.capabilities,
    pricing: {
      promptPer1m: String(model.promptPer1mMicros),
      completionPer1m: String(model.completionPer1mMicros),
    },
    endpoint,
    tee: endpoint.tee,
  };
}
