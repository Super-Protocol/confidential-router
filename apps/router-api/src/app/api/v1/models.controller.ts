import { Controller, Get, Param, Req, UseFilters, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeController } from '@nestjs/swagger';
import { EvidenceService, teeLabelOfBundle } from '../../evidence/index.js';
import { ApiKeyGuard, type ApiKeyRequest, apiKeyOf } from './api-key.guard.js';
import type { RoutedModel } from './gateway.types.js';
import { GatewayPolicyService } from './gateway-policy.service.js';
import { openAiErrors } from './openai-error.js';
import { OpenAiExceptionFilter } from './openai-exception.filter.js';

/**
 * `GET /v1/models` — the OpenAI list shape, plus the fields that make this
 * router worth using: what a model costs, and which attested endpoint serves it
 * (`docs/contracts/router-api.md`).
 *
 * Only models within the key's scope are listed, so a scoped key's model list
 * matches exactly what it is allowed to call.
 *
 * External models (ADR-008) appear here in the same shape as any other, naming
 * their own endpoint — and only while a live verdict admits that endpoint, which
 * is decision 5's fail-closed drop: an upstream the router cannot currently verify
 * is absent from the list and from `GET /v1/models/{id}`, not listed-but-broken.
 *
 * `endpoint.tee` is read from the evidence the endpoint publishes, not from the
 * config (SUP-260): the operator-declared label this used to print was one
 * default for every deployment, whatever hardware it landed on. It is the same
 * value the console's `latestEvidence.tee` shows — read, never verified
 * (ADR-002) — and the key is omitted while the endpoint has published nothing
 * this router recognises, and for an external upstream, whose hardware this
 * router reads no evidence for.
 */
@ApiExcludeController()
@ApiBearerAuth()
@Controller('v1/models')
@UseFilters(OpenAiExceptionFilter)
@UseGuards(ApiKeyGuard)
export class ModelsController {
  constructor(
    private readonly policy: GatewayPolicyService,
    private readonly evidence: EvidenceService,
  ) {}

  @Get()
  async list(@Req() request: ApiKeyRequest): Promise<{ object: 'list'; data: ReturnType<typeof presentModel>[] }> {
    const models = this.policy.listModels(apiKeyOf(request).key);
    const tee = await this.teeLabels(models);
    return { object: 'list', data: models.map((model) => presentModel(model, tee.get(model.endpoint.id) ?? null)) };
  }

  /**
   * A wildcard, not `:id`: model ids carry slashes and colons
   * (`meta/llama-3.3-70b-instruct:tdx`), and a plain parameter stops at the
   * first slash.
   */
  @Get('*id')
  async get(@Req() request: ApiKeyRequest, @Param('id') id: string | string[]) {
    const wanted = Array.isArray(id) ? id.join('/') : id;
    const model = this.policy.listModels(apiKeyOf(request).key).find((candidate) => candidate.id === wanted);
    if (!model) {
      throw openAiErrors.modelNotFound(wanted);
    }
    const tee = await this.teeLabels([model]);
    return presentModel(model, tee.get(model.endpoint.id) ?? null);
  }

  /**
   * The TEE each model's endpoint publishes evidence from, by endpoint id.
   *
   * Only this deployment's own endpoints are looked up: an external upstream's
   * id names an `external_endpoints` row, which holds a verdict about a cloud
   * and no root this reader would name a TEE from.
   */
  private async teeLabels(models: RoutedModel[]): Promise<Map<string, string | null>> {
    const own = [...new Set(models.filter((model) => model.external === null).map((model) => model.endpoint.id))];
    const latest = await this.evidence.latestForMany(own);
    return new Map([...latest].map(([endpointId, snapshot]) => [endpointId, teeLabelOfBundle(snapshot.bundle)]));
  }
}

function presentModel(model: RoutedModel, tee: string | null) {
  return {
    id: model.id,
    object: 'model' as const,
    created: Math.floor(model.updatedAt.getTime() / 1000),
    owned_by: 'confidential-router',
    name: model.name,
    context_length: model.contextLength,
    pricing: {
      prompt_per_1m_micros: model.promptPer1mMicros,
      completion_per_1m_micros: model.completionPer1mMicros,
    },
    endpoint: {
      name: model.endpoint.name,
      hostname: model.endpoint.hostname,
      // Omitted rather than blank when the evidence names nothing, and for an
      // external upstream: the honest answer is that the field is not there
      // (`docs/contracts/router-api.md`), never a label nobody read.
      ...(tee ? { tee } : {}),
    },
    capabilities: model.capabilities,
  };
}
