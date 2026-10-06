import type { CatalogModel } from '../../catalog/catalog.service.js';
import type { ExternalCatalogModel } from '../../external-endpoints/index.js';
import type { RoutedModel } from './gateway.types.js';

/**
 * The two catalogues, flattened into the one shape `/v1` routes on
 * (ADR-008 §4).
 *
 * Kept as two small functions rather than a field on each catalogue entry because
 * the catalogues answer to the console and the admin API as well, and only the
 * gateway needs a model it can forward without asking where it came from.
 */

export function routedConfigModel(model: CatalogModel): RoutedModel {
  return {
    id: model.id,
    name: model.name,
    upstreamModel: model.litellmModel,
    contextLength: model.contextLength,
    capabilities: model.capabilities,
    promptPer1mMicros: model.promptPer1mMicros,
    completionPer1mMicros: model.completionPer1mMicros,
    origin: 'config',
    endpoint: {
      id: model.endpoint.id,
      name: model.endpoint.name,
      hostname: model.endpoint.hostname,
      tee: model.endpoint.tee,
    },
    external: null,
    updatedAt: model.updatedAt,
  };
}

export function routedExternalModel(model: ExternalCatalogModel): RoutedModel {
  return {
    id: model.id,
    name: model.name,
    upstreamModel: model.upstreamModel,
    contextLength: model.contextLength,
    capabilities: model.capabilities,
    promptPer1mMicros: model.promptPer1mMicros,
    completionPer1mMicros: model.completionPer1mMicros,
    origin: 'external',
    endpoint: {
      id: model.endpoint.id,
      name: model.endpoint.name,
      // The upstream's own hostname, not the loopback listener: this is what
      // `usage.endpoint` and the response header name, and a client comparing it
      // against the evidence it inspected has to see the host the evidence is for.
      hostname: model.endpoint.hostname,
      // Null for an external upstream, which has no `endpoints` row to carry a
      // declared label and no admin field that would have set one.
      tee: model.tee,
    },
    external: {
      baseUrl: `http://127.0.0.1:${model.endpoint.listenPort}`,
      apiKeyCiphertext: model.endpoint.apiKeyCiphertext,
      evidenceDigestSeen: model.endpoint.evidenceDigestSeen,
      measurementSeen: model.endpoint.measurementSeen,
    },
    updatedAt: model.updatedAt,
  };
}
