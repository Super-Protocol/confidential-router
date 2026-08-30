import { Controller, Get, Param, Req, UseFilters, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeController } from '@nestjs/swagger';
import type { CatalogModel } from '../../catalog/catalog.service.js';
import { ApiKeyGuard, type ApiKeyRequest, apiKeyOf } from './api-key.guard.js';
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
 */
@ApiExcludeController()
@ApiBearerAuth()
@Controller('v1/models')
@UseFilters(OpenAiExceptionFilter)
@UseGuards(ApiKeyGuard)
export class ModelsController {
  constructor(private readonly policy: GatewayPolicyService) {}

  @Get()
  list(@Req() request: ApiKeyRequest): { object: 'list'; data: ReturnType<typeof presentModel>[] } {
    const models = this.policy.listModels(apiKeyOf(request).key);
    return { object: 'list', data: models.map(presentModel) };
  }

  /**
   * A wildcard, not `:id`: model ids carry slashes and colons
   * (`meta/llama-3.3-70b-instruct:tdx`), and a plain parameter stops at the
   * first slash.
   */
  @Get('*id')
  get(@Req() request: ApiKeyRequest, @Param('id') id: string | string[]) {
    const wanted = Array.isArray(id) ? id.join('/') : id;
    const model = this.policy.listModels(apiKeyOf(request).key).find((candidate) => candidate.id === wanted);
    if (!model) {
      throw openAiErrors.modelNotFound(wanted);
    }
    return presentModel(model);
  }
}

function presentModel(model: CatalogModel) {
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
      tee: model.endpoint.tee,
    },
    capabilities: model.capabilities,
  };
}
