import { All, Controller, UseFilters } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { openAiErrors } from './openai-error.js';
import { OpenAiExceptionFilter } from './openai-exception.filter.js';

/**
 * Anything under `/v1` the router does not implement.
 *
 * Registered last in the module so the real routes match first. It exists so an
 * SDK calling, say, `/v1/moderations` gets the OpenAI error envelope rather than
 * Nest's `{"statusCode":404,"message":"Cannot POST /v1/moderations"}`, which no
 * OpenAI client knows how to read.
 *
 * Unauthenticated on purpose: a path that does not exist does not exist,
 * whoever is asking.
 */
@ApiExcludeController()
@Controller('v1')
@UseFilters(OpenAiExceptionFilter)
export class V1FallbackController {
  @All('*path')
  notFound(): never {
    throw openAiErrors.notFound();
  }
}
