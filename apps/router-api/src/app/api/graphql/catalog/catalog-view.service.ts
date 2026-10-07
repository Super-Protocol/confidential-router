import { Injectable } from '@nestjs/common';
import type { CatalogModel } from '../../../catalog/catalog.service.js';
import { CatalogService } from '../../../catalog/catalog.service.js';
import { EvidenceCoverageStatsService, EvidenceService } from '../../../evidence/index.js';
import { ExternalCatalogService, type ExternalCatalogueEntry } from '../../../external-endpoints/index.js';
import { EndpointModel } from './endpoint.model.js';
import { EvidenceSnapshotModel } from './evidence.model.js';
import { LlmModel, ModelOriginEnum } from './model.model.js';

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
  // biome-ignore lint/complexity/useMaxParams: a Nest DI constructor has no call site to keep readable.
  constructor(
    private readonly catalog: CatalogService,
    private readonly external: ExternalCatalogService,
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
        declaredImages: endpoint.declaredImages,
        latestEvidence: snapshot ? EvidenceSnapshotModel.from(snapshot, now) : null,
        evidenceState: this.evidence.stateOfSnapshot(snapshot, now),
        tokensRouted30d: tokens.get(endpoint.id) ?? 0,
      };
    });
  }

  /**
   * The endpoint that *is* this deployment, projected like any other, or null
   * when the router cannot tell which of its endpoints is its own.
   *
   * It is what `GET /v1/evidence` answers for, and the console needs the same
   * answer for the same reason the chat's gate does: the browser's TLS channel
   * terminates here, so this is the endpoint a page can verify. For a built-in
   * model it is also the endpoint that serves it; for an external one the two
   * come apart, and the gate still belongs to this one — the upstream's channel
   * is pinned by the egress sidecar, which is inside this deployment's own
   * snapshot (ADR-008 §1).
   */
  async ownEndpointView(workspaceId: string | null, now: Date = new Date()): Promise<EndpointModel | null> {
    const own = await this.evidence.ownEndpoint();
    if (!own) {
      return null;
    }
    const views = await this.endpointViews(workspaceId, now);
    return views.find((view) => view.id === own.id) ?? null;
  }

  /**
   * The whole catalogue: the config's models in config order, then the registered
   * external ones in model-id order.
   *
   * One list rather than two root fields, because both consuming screens want one
   * table and one picker — and the thing that tells the two kinds apart on a row
   * is `origin`, which the `models` table already stores. What must never be
   * blended is the *attestation* the row carries, and that is enforced by the
   * types: a config row has `endpoint` and no `externalUpstream`, an external row
   * the reverse (ADR-008 §1).
   *
   * @param signedIn whether there is a viewer at all. An external model's upstream
   *   is readable by any signed-in user and by nobody else (SUP-221 ruling 3), so
   *   this decides whether `externalUpstream` is populated — not which models are
   *   listed, which is the same catalogue for everyone.
   */
  async modelViews(input: {
    workspaceId: string | null;
    signedIn: boolean;
    tee?: string | null;
    now?: Date;
  }): Promise<LlmModel[]> {
    const now = input.now ?? new Date();
    const endpoints = new Map((await this.endpointViews(input.workspaceId, now)).map((view) => [view.id, view]));
    const tee = input.tee;

    const config = this.catalog
      .list()
      .filter((model) => !tee || model.endpoint.tee === tee)
      .flatMap((model) => {
        const endpoint = endpoints.get(model.endpoint.id);
        // A model whose endpoint is not in the active set cannot be routed to,
        // so listing it would offer the console something it cannot use.
        return endpoint ? [toModelView(model, endpoint)] : [];
      });

    /*
     * A TEE filter excludes every external model, and that is the filter being
     * honest rather than losing rows: the label it narrows on is an operator's
     * declaration about this deployment's own hardware, and this router has none
     * to make about someone else's. "All TEEs" is the only tab externals appear
     * under.
     */
    const external = tee
      ? []
      : this.external.listCatalogue().map((entry) => toExternalModelView(entry, input.signedIn));

    return [...config, ...external];
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
    origin: ModelOriginEnum.CONFIG,
    // Config models are projected from the snapshot the user pins and are routable
    // whenever they are listed; the endpoint's publication state is a separate
    // statement and deliberately not folded in here.
    available: true,
    endpoint,
    externalUpstream: null,
    tee: endpoint.tee,
  };
}

function toExternalModelView(entry: ExternalCatalogueEntry, signedIn: boolean): LlmModel {
  return {
    id: entry.id,
    slug: entry.id,
    name: entry.name,
    contextLength: entry.contextLength,
    capabilities: entry.capabilities,
    pricing: {
      promptPer1m: String(entry.promptPer1mMicros),
      completionPer1m: String(entry.completionPer1mMicros),
    },
    origin: ModelOriginEnum.EXTERNAL,
    available: entry.available,
    endpoint: null,
    externalUpstream: signedIn ? entry.upstream : null,
    tee: null,
  };
}
