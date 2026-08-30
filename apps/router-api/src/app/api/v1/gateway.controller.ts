import { Controller, Post, Req, Res, UseFilters, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import { ApiKeyGuard, type ApiKeyRequest } from './api-key.guard.js';
import { GatewayService } from './gateway.service.js';
import { OpenAiExceptionFilter } from './openai-exception.filter.js';

/**
 * The OpenAI-compatible inference routes.
 *
 * `@Res()` on every handler because the router writes the response itself: a
 * streaming completion is bytes on the wire long before the handler returns,
 * and Nest's automatic serialisation has nothing useful to do with it.
 *
 * Excluded from Swagger: this surface is the OpenAI API and is documented as
 * such in `docs/contracts/router-api.md`; a half-transcribed copy in the
 * console's own schema would only go stale.
 */
@ApiExcludeController()
@ApiBearerAuth()
@Controller('v1')
@UseFilters(OpenAiExceptionFilter)
@UseGuards(ApiKeyGuard)
export class GatewayController {
  constructor(private readonly gateway: GatewayService) {}

  @Post('chat/completions')
  async chatCompletions(@Req() request: ApiKeyRequest, @Res() response: Response): Promise<void> {
    await this.gateway.handle(request, response, 'chat');
  }

  @Post('completions')
  async completions(@Req() request: ApiKeyRequest, @Res() response: Response): Promise<void> {
    await this.gateway.handle(request, response, 'completions');
  }

  @Post('embeddings')
  async embeddings(@Req() request: ApiKeyRequest, @Res() response: Response): Promise<void> {
    await this.gateway.handle(request, response, 'embeddings');
  }
}
