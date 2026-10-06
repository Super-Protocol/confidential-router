import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ExternalEndpoint } from '../db/entities/external-endpoint.entity.js';
import { Model, type ModelCapability } from '../db/entities/model.entity.js';

/** An external upstream, as the gateway's egress leg needs it. */
export interface ExternalCatalogEndpoint {
  id: string;
  name: string;
  baseUrl: string;
  /** The sidecar's loopback listener — where router-api actually sends the request. */
  listenPort: number;
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
  tee: string;
  endpoint: ExternalCatalogEndpoint;
  updatedAt: Date;
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
   * Rebuilds the map from the database.
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
      (
        await this.dataSource.getRepository(ExternalEndpoint).find({ where: { enabled: true, status: 'verified' } })
      ).map((endpoint) => [endpoint.id, endpoint]),
    );

    const models = new Map<string, ExternalCatalogModel>();
    for (const row of rows) {
      const endpoint = row.externalEndpointId ? endpoints.get(row.externalEndpointId) : undefined;
      if (!endpoint) {
        // Either the endpoint is disabled, or it has no live verdict admitting
        // it. Both mean the same thing here: not routable.
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
        tee: row.tee,
        endpoint: {
          id: endpoint.id,
          name: endpoint.name,
          baseUrl: endpoint.baseUrl,
          listenPort: endpoint.listenPort,
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
    return models.size;
  }
}
