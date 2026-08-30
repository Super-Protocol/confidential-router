import { Controller, Get, Query, Req, UseFilters, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeController } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CatalogService } from '../../catalog/catalog.service.js';
import { Generation } from '../../db/entities/generation.entity.js';
import { ApiKeyGuard, type ApiKeyRequest, apiKeyOf } from './api-key.guard.js';
import { openAiErrors } from './openai-error.js';
import { OpenAiExceptionFilter } from './openai-exception.filter.js';

/**
 * `GET /v1/generation?id=gen-…` — the metering record of one request, the way
 * OpenRouter exposes it, so a client can reconcile what it was charged.
 *
 * Scoped to the calling key's workspace. Never any content: there is none to
 * return (`data-model.md` invariant 1).
 */
@ApiExcludeController()
@ApiBearerAuth()
@Controller('v1/generation')
@UseFilters(OpenAiExceptionFilter)
@UseGuards(ApiKeyGuard)
export class GenerationsController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly catalog: CatalogService,
  ) {}

  @Get()
  async get(@Req() request: ApiKeyRequest, @Query('id') id?: string) {
    if (!id) {
      throw openAiErrors.missingField('id');
    }
    const workspaceId = apiKeyOf(request).workspace.id;
    const generation = await this.dataSource.getRepository(Generation).findOne({ where: { id, workspaceId } });
    if (!generation) {
      throw openAiErrors.notFound();
    }
    return { data: present(generation, this.catalog.endpointById(generation.endpointId)?.name ?? null) };
  }
}

function present(generation: Generation, endpointName: string | null) {
  return {
    id: generation.id,
    model: generation.modelId,
    endpoint: endpointName,
    created_at: generation.createdAt.toISOString(),
    streamed: generation.streamed,
    status: generation.status,
    finish_reason: generation.finishReason,
    prompt_tokens: generation.promptTokens,
    completion_tokens: generation.completionTokens,
    total_tokens: generation.promptTokens + generation.completionTokens,
    cost_micros: generation.costMicros,
    latency_ms: generation.latencyMs,
    time_to_first_token_ms: generation.timeToFirstTokenMs,
    tokens_per_second: generation.tokensPerSecond,
    evidence_digest: generation.evidenceDigest,
  };
}
