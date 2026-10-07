import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ExternalEndpoint, type ExternalEndpointStatus } from '../db/entities/external-endpoint.entity.js';
import { Model, type ModelCapability } from '../db/entities/model.entity.js';

/** An external upstream, as the gateway's egress leg needs it. */
export interface ExternalCatalogEndpoint {
  id: string;
  name: string;
  /** The upstream's own hostname — what the evidence was fetched from and bound to. */
  hostname: string;
  baseUrl: string;
  /** The sidecar's loopback listener — where router-api actually sends the request. */
  listenPort: number;
  /** The upstream's LLM API key, still sealed. Opened per request by the egress leg. */
  apiKeyCiphertext: string;
  measurementSeen: string | null;
  evidenceDigestSeen: string | null;
}

/** A model on an external endpoint, with admin-set prices frozen per generation like any other. */
export interface ExternalCatalogModel {
  id: string;
  name: string;
  /** The name the *upstream* knows this model by; the egress leg rewrites `model` to it. */
  upstreamModel: string;
  contextLength: number;
  capabilities: ModelCapability[];
  promptPer1mMicros: number;
  completionPer1mMicros: number;
  /** Null unless a deployment registered one before the field left the API. */
  tee: string | null;
  endpoint: ExternalCatalogEndpoint;
  updatedAt: Date;
}

/**
 * A registered external model whose endpoint holds no verdict admitting it.
 *
 * Kept apart from the routable map rather than forgotten, because the two
 * refusals an admission has to tell apart are "this model does not exist" and
 * "this model exists and I will not proxy to it" — the second is a 503
 * `attestation_failed` naming the stage that denied, the first a 404. A model that
 * simply vanished from the catalogue would make every denial read as a typo.
 */
export interface UnadmittedExternalModel {
  id: string;
  endpointName: string;
  status: ExternalEndpointStatus;
  /** ADR-003 §1 stage of the last denial, when there was one. */
  stage: string | null;
  reason: string | null;
}

/**
 * The upstream behind an external model, as a *catalogue* reader may see it.
 *
 * Deliberately smaller than `ExternalEndpoint`: no base URL, no key prefix, no
 * listen port. The Models page and the chat picker need to name the upstream and
 * say where this router's verdict stands, and nothing more — and ruling 3 on
 * SUP-221 draws the line in the same place for the anonymous caller, who gets
 * none of it.
 */
export interface ExternalCatalogueUpstream {
  id: string;
  /** Also the key of this router's evidence relay, `GET /v1/evidence/:endpoint`. */
  name: string;
  hostname: string;
  status: ExternalEndpointStatus;
  lastCheckedAt: Date | null;
  measurementSeen: string | null;
  evidenceDigestSeen: string | null;
}

/**
 * One external model as the public catalogue lists it, routable or not.
 *
 * The third projection of the same rows, beside {@link ExternalCatalogModel}
 * (what the egress leg needs) and {@link UnadmittedExternalModel} (what a refusal
 * needs), and it exists because the user-facing surfaces have the one requirement
 * neither of those has: they must be able to render *"denied by this router"*.
 * A catalogue that dropped a denied model would leave that vocabulary with
 * nothing to say it about, and the operator's own switch would look identical to
 * a failed attestation.
 *
 * A model whose endpoint an operator has **disabled** is absent even here — that
 * is a row taken out of service rather than a verdict, and the refresh below
 * never sees it.
 */
export interface ExternalCatalogueEntry {
  id: string;
  name: string;
  contextLength: number;
  capabilities: ModelCapability[];
  promptPer1mMicros: number;
  completionPer1mMicros: number;
  /** Whether this router will route to it right now — the endpoint holds a live admitting verdict. */
  available: boolean;
  upstream: ExternalCatalogueUpstream;
}

/**
 * The second in-memory catalogue: external models, beside the config one
 * (ADR-008 §6).
 *
 * `CatalogService` resolves once at boot and says why — "the config cannot change
 * underneath a running process". That assumption is still true, and this class
 * exists so that it stays narrowly true: external models *can* change underneath
 * a running process, twice over. An admin registers or edits one, and the sidecar
 * flips an endpoint's verdict. Both call {@link refresh}.
 *
 * Membership is the fail-closed drop of decision 5, and it is a property of this
 * map rather than a check at the call site: a model is here **iff** its endpoint
 * is enabled and `verified`. A denied upstream therefore disappears from
 * `/v1/models` and stops resolving at admission, in the same refresh that the
 * status poll triggers — and it is refused at the egress as well, because the
 * sidecar is fail-closed. Two independent refusals for one rule, which is what
 * "immediately drops the model" has to mean when the two live in different
 * processes.
 */
@Injectable()
export class ExternalCatalogService {
  private readonly logger = new Logger(ExternalCatalogService.name);
  private models = new Map<string, ExternalCatalogModel>();
  private unadmitted = new Map<string, UnadmittedExternalModel>();
  private catalogue: ExternalCatalogueEntry[] = [];

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** Routable external models, in model-id order. Empty until an endpoint is verified. */
  list(scope: readonly string[] | null = null): ExternalCatalogModel[] {
    const models = [...this.models.values()];
    return scope ? models.filter((model) => scope.includes(model.id)) : models;
  }

  find(id: string): ExternalCatalogModel | undefined {
    return this.models.get(id);
  }

  /**
   * Every external model on an enabled endpoint, routable or not, in model-id
   * order — what the Models page and the chat picker are built from.
   *
   * Chat capability is not filtered here: the picker narrows on it (as it already
   * does for built-ins) and the Models page must list an embeddings-only upstream
   * like any other.
   */
  listCatalogue(): ExternalCatalogueEntry[] {
    return this.catalogue;
  }

  /**
   * A registered external model that is *not* routable, so admission can refuse it
   * as policy rather than as a missing id. Undefined for anything this router has
   * never heard of — and for a model on a `disabled` endpoint, which an admin took
   * out of service: that is not a failed attestation and must not be reported as
   * one.
   */
  findUnadmitted(id: string): UnadmittedExternalModel | undefined {
    return this.unadmitted.get(id);
  }

  /**
   * Rebuilds the maps from the database.
   *
   * A full rebuild rather than an incremental patch, for the reason the
   * gatekeeper's own dashboard snapshots are full rather than incremental: a
   * reader that missed an update must not be able to drift. There are tens of
   * these rows, not thousands.
   */
  async refresh(): Promise<number> {
    const rows = await this.dataSource.getRepository(Model).find({
      where: { origin: 'external', enabled: true },
      order: { id: 'ASC' },
    });
    const endpoints = new Map(
      (await this.dataSource.getRepository(ExternalEndpoint).find({ where: { enabled: true } })).map((endpoint) => [
        endpoint.id,
        endpoint,
      ]),
    );

    const models = new Map<string, ExternalCatalogModel>();
    const unadmitted = new Map<string, UnadmittedExternalModel>();
    const catalogue: ExternalCatalogueEntry[] = [];
    for (const row of rows) {
      const endpoint = row.externalEndpointId ? endpoints.get(row.externalEndpointId) : undefined;
      if (!endpoint) {
        // The endpoint is disabled, or gone. An operator's switch, not a verdict:
        // the model is simply not in the catalogue, the same as a retired one.
        continue;
      }
      catalogue.push(catalogueEntryOf(row, endpoint));
      if (endpoint.status !== 'verified') {
        unadmitted.set(row.id, {
          id: row.id,
          endpointName: endpoint.name,
          status: endpoint.status,
          stage: endpoint.lastStage,
          reason: endpoint.lastReason,
        });
        continue;
      }
      models.set(row.id, {
        id: row.id,
        name: row.name,
        upstreamModel: row.litellmModel,
        contextLength: row.contextLength,
        capabilities: row.capabilities,
        promptPer1mMicros: row.promptPer1mMicros,
        completionPer1mMicros: row.completionPer1mMicros,
        tee: row.tee || null,
        endpoint: {
          id: endpoint.id,
          name: endpoint.name,
          hostname: endpoint.hostname,
          baseUrl: endpoint.baseUrl,
          listenPort: endpoint.listenPort,
          apiKeyCiphertext: endpoint.apiKeyCiphertext,
          measurementSeen: endpoint.measurementSeen,
          evidenceDigestSeen: endpoint.evidenceDigestSeen,
        },
        updatedAt: row.updatedAt,
      });
    }

    if (models.size !== this.models.size) {
      this.logger.log(`External catalogue: ${models.size} routable model(s) (was ${this.models.size}).`);
    }
    this.models = models;
    this.unadmitted = unadmitted;
    this.catalogue = catalogue;
    return models.size;
  }
}

/**
 * One catalogue row, with `available` derived from the endpoint rather than
 * stored.
 *
 * No TEE label: `models.tee` survives on these rows only from before the field
 * left the registration API (ADR-008 §6), and relaying a vestigial value as
 * though this deployment declared it would be the one fabrication the user
 * surfaces must not make. A measurement admits a cloud and does not name its
 * silicon, which is what `Model.tee: null` says for an external model.
 *
 * Derived on purpose: availability *is* the live verdict plus the operator's
 * switch, and a second column holding it would be a copy of two values that can
 * both move — which is the shape a fail-closed rule must not be written in
 * (decision 5).
 */
function catalogueEntryOf(row: Model, endpoint: ExternalEndpoint): ExternalCatalogueEntry {
  return {
    id: row.id,
    name: row.name,
    contextLength: row.contextLength,
    capabilities: row.capabilities,
    promptPer1mMicros: row.promptPer1mMicros,
    completionPer1mMicros: row.completionPer1mMicros,
    available: endpoint.status === 'verified',
    upstream: {
      id: endpoint.id,
      name: endpoint.name,
      hostname: endpoint.hostname,
      status: endpoint.status,
      lastCheckedAt: endpoint.lastCheckedAt,
      measurementSeen: endpoint.measurementSeen,
      evidenceDigestSeen: endpoint.evidenceDigestSeen,
    },
  };
}
