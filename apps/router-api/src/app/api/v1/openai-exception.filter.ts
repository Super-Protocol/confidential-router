import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
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
 * middleware, before routing. Mounted right after `express.json()` in
 * `configureApp`, this hands `/v1` clients `invalid_json` instead of Express's
 * HTML error page.
 */
// biome-ignore lint/complexity/useMaxParams: Express recognises an error handler by its arity — four parameters is the signature.
export function jsonErrorMiddleware(
  error: unknown,
  request: Request,
  response: Response,
  next: (error?: unknown) => void,
): void {
  const isBodyParserError =
    error instanceof SyntaxError && 'body' in error && (error as { status?: number }).status === 400;
  if (!isBodyParserError || !request.path.startsWith('/v1')) {
    next(error);
    return;
  }
  const openAiError = openAiErrors.invalidJson();
  response.status(openAiError.status).type('application/json').send(openAiError.toBody());
}
