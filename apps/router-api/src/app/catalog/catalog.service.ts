import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In, Not } from 'typeorm';
import { routerConfig } from '../config.js';
import { Endpoint } from '../db/entities/endpoint.entity.js';
import { Model, type ModelCapability } from '../db/entities/model.entity.js';

/** A router hostname, as the gateway needs it: config values plus the projected row id. */
export interface CatalogEndpoint {
  id: string;
  name: string;
  hostname: string;
  tee: string;
}

/** A model the gateway can route to, joined with its endpoint and frozen prices. */
export interface CatalogModel {
  id: string;
  name: string;
  litellmModel: string;
  contextLength: number;
  capabilities: ModelCapability[];
  promptPer1mMicros: number;
  completionPer1mMicros: number;
  endpoint: CatalogEndpoint;
  /** When this projection was written; surfaced as OpenAI's `created`. */
  updatedAt: Date;
}

export class UnknownEndpointError extends Error {
  constructor(modelId: string, endpointName: string) {
    super(`Model "${modelId}" references endpoint "${endpointName}", which is not declared under endpoints[].`);
    this.name = 'UnknownEndpointError';
  }
}

/**
 * The router config's `endpoints[]` and `models[]`, resolved once at boot.
 *
 * Two jobs, deliberately in one place. It *projects* both lists into the
 * `endpoints` / `models` tables so a `Generation` can take a foreign key on the
 * model it used (`docs/contracts/data-model.md` invariant 4: rows are re-derived
 * from the config, never edited through the API, and a dropped entry is kept
 * with `enabled = false` so past generations still resolve). And it *serves*
 * the resolved catalogue from memory, because `/v1/chat/completions` looks a
 * model up on every single request and the config cannot change underneath a
 * running process.
 */
@Injectable()
export class CatalogService implements OnApplicationBootstrap {
  private readonly logger = new Logger(CatalogService.name);
  private models = new Map<string, CatalogModel>();
  private endpoints = new Map<string, CatalogEndpoint>();

  constructor(
    @Inject(routerConfig.KEY) private readonly config: ConfigType<typeof routerConfig>,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.project();
  }

  /** Enabled models, in config order, restricted to `scope` when the key has one. */
  list(scope: readonly string[] | null = null): CatalogModel[] {
    const models = [...this.models.values()];
    return scope ? models.filter((model) => scope.includes(model.id)) : models;
  }

  find(id: string): CatalogModel | undefined {
    return this.models.get(id);
  }

  endpointById(id: string): CatalogEndpoint | undefined {
    return [...this.endpoints.values()].find((endpoint) => endpoint.id === id);
  }

  /**
   * Re-derives the tables from the config and rebuilds the in-memory index.
   *
   * One transaction: a half-applied projection would leave models pointing at
   * endpoints that are not there yet.
   */
  private async project(): Promise<void> {
    const enabledEndpoints = this.config.endpoints.filter((endpoint) => endpoint.enabled);
    const enabledModels = this.config.models.filter((model) => model.enabled);

    for (const model of enabledModels) {
      if (!enabledEndpoints.some((endpoint) => endpoint.name === model.endpoint)) {
        throw new UnknownEndpointError(model.id, model.endpoint);
      }
    }

    const endpoints = new Map<string, CatalogEndpoint>();
    const models = new Map<string, CatalogModel>();

    await this.dataSource.transaction(async (manager) => {
      const now = new Date();
      const existing = await manager.find(Endpoint, { where: { name: In(enabledEndpoints.map((e) => e.name)) } });
      const idByName = new Map(existing.map((row) => [row.name, row.id]));

      for (const endpoint of enabledEndpoints) {
        const id = idByName.get(endpoint.name) ?? randomUUID();
        await manager.save(Endpoint, {
          id,
          name: endpoint.name,
          hostname: endpoint.hostname,
          tee: endpoint.tee,
          evidenceUrl: endpoint.evidenceUrl ?? null,
          enabled: true,
          updatedAt: now,
        });
        endpoints.set(endpoint.name, { id, name: endpoint.name, hostname: endpoint.hostname, tee: endpoint.tee });
      }

      for (const model of enabledModels) {
        // Non-null: the loop above put every enabled endpoint in the map, and
        // the pre-flight check refused any model that names another one.
        const endpoint = endpoints.get(model.endpoint) as CatalogEndpoint;
        await manager.save(Model, {
          id: model.id,
          name: model.name,
          litellmModel: model.litellmModel,
          endpointId: endpoint.id,
          contextLength: model.contextLength,
          capabilities: model.capabilities,
          promptPer1mMicros: model.pricing.promptPer1mMicros,
          completionPer1mMicros: model.pricing.completionPer1mMicros,
          tee: endpoint.tee,
          enabled: true,
          updatedAt: now,
        });
        models.set(model.id, {
          id: model.id,
          name: model.name,
          litellmModel: model.litellmModel,
          contextLength: model.contextLength,
          capabilities: model.capabilities,
          promptPer1mMicros: model.pricing.promptPer1mMicros,
          completionPer1mMicros: model.pricing.completionPer1mMicros,
          endpoint,
          updatedAt: now,
        });
      }

      // Anything the config no longer lists is retired rather than deleted:
      // generations keep their foreign keys, the console stops offering it.
      await this.retire(manager, Model, [...models.keys()]);
      await this.retire(
        manager,
        Endpoint,
        [...endpoints.values()].map((endpoint) => endpoint.id),
      );
    });

    this.models = models;
    this.endpoints = endpoints;
    this.logger.log(`Catalogue: ${models.size} model(s) across ${endpoints.size} endpoint(s)`);
  }

  private async retire(
    manager: DataSource['manager'],
    entity: typeof Model | typeof Endpoint,
    keptIds: string[],
  ): Promise<void> {
    // `Not(In([]))` is not a valid predicate on either driver, so an empty
    // config — which is the default in development — retires everything.
    const where = keptIds.length > 0 ? { id: Not(In(keptIds)), enabled: true } : { enabled: true };
    await manager.update(entity, where, { enabled: false, updatedAt: new Date() });
  }
}
