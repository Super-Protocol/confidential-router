import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { V1_BASE_PATH } from './gateway.types.js';
import { asOpenAiError, OpenAiApiError, openAiErrors } from './openai-error.js';

/**
 * Turns every failure under `/v1` into an OpenAI-shaped JSON error.
 *
 * Applied to the `/v1` controllers only: the console's REST and GraphQL
 * surfaces keep Nest's own error format, and mixing the two would leave clients
 * of either guessing.
 *
 * A response whose headers are already out (a stream that failed mid-flight)
 * is left alone — the streaming path has its own terminator, and writing a
 * second set of headers here would only produce an ERR_HTTP_HEADERS_SENT.
 */
@Catch()
export class OpenAiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('V1');

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const response = context.getResponse<Response>();
    const request = context.getRequest<Request>();

    const error = toOpenAiError(exception);
    if (error.status >= 500 && !(exception instanceof OpenAiApiError)) {
      this.logger.error(
        `${request.method} ${request.originalUrl} failed: ${
          exception instanceof Error ? (exception.stack ?? exception.message) : String(exception)
        }`,
      );
    }

    if (response.headersSent) {
      response.end();
      return;
    }

    for (const [header, value] of Object.entries(error.headers)) {
      response.setHeader(header, value);
    }
    response.status(error.status).type('application/json').send(error.toBody());
  }
}

/**
 * Nest raises `HttpException` for things the framework rejects before a handler
 * runs — an unmatched route, a payload over the body limit. Those still have to
 * come back in the OpenAI shape.
 */
function toOpenAiError(exception: unknown): OpenAiApiError {
  if (exception instanceof OpenAiApiError) {
    return exception;
  }
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    if (status === 404) {
      return openAiErrors.notFound();
    }
    if (status < 500) {
      return new OpenAiApiError({
        status,
        type: 'invalid_request_error',
        code: 'invalid_request',
        message: exception.message,
      });
    }
  }
  return asOpenAiError(exception);
}

/**
 * Express body-parser failures never reach a Nest filter — they are thrown in
 * middleware, before routing. Mounted right after the `express.json()` parsers in
 * `configureApp`, this hands `/v1` clients the router's own error shape instead of
 * Express's HTML page or Nest's `{ statusCode, message }`.
 */
// biome-ignore lint/complexity/useMaxParams: Express recognises an error handler by its arity — four parameters is the signature.
export function jsonErrorMiddleware(
  error: unknown,
  request: Request,
  response: Response,
  next: (error?: unknown) => void,
): void {
  const openAiError = request.path.startsWith(V1_BASE_PATH) ? bodyParserErrorOf(error) : null;
  if (!openAiError) {
    next(error);
    return;
  }
  response.status(openAiError.status).type('application/json').send(openAiError.toBody());
}

/**
 * The two ways `express.json` refuses a body, in the router's vocabulary — or
 * null for anything that is not a parser refusal and belongs further down the
 * chain.
 *
 * `entity.too.large` used to fall through to Nest and arrive as a bare
 * `{"statusCode":413,"message":"request entity too large"}` (SUP-339): a shape no
 * OpenAI SDK unpacks, carrying neither the code a client branches on nor the limit
 * it would need in order to send something smaller. `body-parser` puts the
 * configured ceiling on the error as `limit`, which is where that number comes
 * from.
 */
function bodyParserErrorOf(error: unknown): OpenAiApiError | null {
  const refusal = error as { status?: number; type?: string; limit?: number } | null;
  if (error instanceof SyntaxError && 'body' in error && refusal?.status === 400) {
    return openAiErrors.invalidJson();
  }
  if (refusal?.type === 'entity.too.large') {
    return openAiErrors.requestTooLarge(typeof refusal.limit === 'number' ? refusal.limit : null);
  }
  return null;
}
