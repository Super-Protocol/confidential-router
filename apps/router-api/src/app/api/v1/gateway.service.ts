import { Injectable, Logger } from '@nestjs/common';
import type { Response as ExpressResponse } from 'express';
import { estimatePromptTokens } from '../../metering/token-estimator.js';
import { type ApiKeyRequest, apiKeyOf } from './api-key.guard.js';
import type { GatewayContext, GenerationOutcome, RouteKind } from './gateway.types.js';
import { UPSTREAM_PATHS } from './gateway.types.js';
import { GatewayPolicyService } from './gateway-policy.service.js';
import { GenerationRecorder } from './generation-recorder.service.js';
import { LiteLlmClient } from './litellm.client.js';
import { OpenAiApiError, openAiErrors } from './openai-error.js';
import { readUsage, shapeResponse } from './response-shaping.js';
import { extensionFor, relayStream } from './stream-relay.js';

/**
 * The `/v1` request path, end to end: admit, forward, shape, meter.
 *
 * Written as one readable sequence on purpose — the order of admission checks,
 * the point at which a generation id is minted, and the guarantee that every
 * forwarded request produces exactly one metering row are the properties this
 * file exists to make obvious.
 */
@Injectable()
export class GatewayService {
  private readonly logger = new Logger(GatewayService.name);

  constructor(
    private readonly policy: GatewayPolicyService,
    private readonly recorder: GenerationRecorder,
    private readonly upstream: LiteLlmClient,
  ) {}

  async handle(request: ApiKeyRequest, response: ExpressResponse, kind: RouteKind): Promise<void> {
    const auth = apiKeyOf(request);
    const body = bodyOf(request);
    const model = this.policy.resolve(kind, body, auth.key);
    const rateLimitHeaders = await this.policy.admit(auth);

    const start = await this.recorder.begin(model.endpoint.id);
    const stream = kind !== 'embeddings' && body.stream === true;
    const clientWantsUsage = usageRequested(body);

    const context: GatewayContext = {
      kind,
      generationId: start.id,
      model,
      auth,
      body,
      stream,
      suppressUsageChunk: stream && !clientWantsUsage,
      coverage: start.coverage,
      rateLimitHeaders,
      requestId: headerOf(request, 'x-request-id'),
      clientIp: request.ip ?? null,
      startedAt: Date.now(),
    };

    for (const [header, value] of Object.entries(rateLimitHeaders)) {
      response.setHeader(header, value);
    }
    if (context.requestId) {
      response.setHeader('X-Request-Id', context.requestId);
    }

    const abort = new AbortController();
    let upstreamResponse: Response;
    try {
      upstreamResponse = await this.upstream.send({
        path: UPSTREAM_PATHS[kind],
        body: upstreamBodyFor(context),
        generationId: context.generationId,
        stream,
        signal: abort.signal,
      });
    } catch (error) {
      throw await this.fail(context, openAiErrors.backendUnavailable(messageOf(error)));
    }

    if (!upstreamResponse.ok) {
      throw await this.fail(context, await this.mapUpstreamFailure(upstreamResponse));
    }

    const outcome = stream
      ? await relayStream({
          context,
          upstream: upstreamResponse,
          response,
          readTimeoutMs: this.upstream.readTimeoutMs,
          abort,
        })
      : await this.completeOnce(context, upstreamResponse, response);

    await this.policy.settle(auth.key, outcome.promptTokens + outcome.completionTokens);
    await this.recorder.finish(context, outcome);
  }

  /**
   * A request that reached the backend and came back whole. The body is parsed
   * only to rewrite the identity fields and attach the usage extension — the
   * choices themselves are passed through as the backend produced them.
   */
  private async completeOnce(
    context: GatewayContext,
    upstream: Response,
    response: ExpressResponse,
  ): Promise<GenerationOutcome> {
    const raw = await upstream.text();
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw await this.fail(context, openAiErrors.backendError('The backend returned a body that is not JSON.'));
    }
    if (!payload || typeof payload !== 'object') {
      throw await this.fail(context, openAiErrors.backendError('The backend returned an unexpected body.'));
    }

    const counts = readUsage(payload) ?? { promptTokens: estimatePromptTokens(context.body), completionTokens: 0 };
    const shaped = shapeResponse(payload as Record<string, unknown>, context, extensionFor(context, counts));

    response.setHeader('X-Confidential-Router-Endpoint', context.model.endpoint.hostname);
    response.setHeader('X-Confidential-Router-Generation-Id', context.generationId);
    response.status(200).type('application/json').send(shaped);

    return {
      ...counts,
      status: 'ok',
      errorCode: null,
      finishReason: finishReasonOfBody(payload),
      timeToFirstTokenMs: null,
    };
  }

  /**
   * Maps a backend failure onto the router's error table.
   *
   * Deliberately conservative in two directions. Only the cases a *client* can
   * act on come back as 4xx — a misconfigured LiteLLM key or a crashed worker is
   * the operator's problem, and telling the caller it made a bad request would
   * be a lie. And the backend's own wording is logged rather than forwarded,
   * except for the context-length message, which is the one thing in it the
   * caller can actually do something about; the rest is cluster-internal detail
   * that a bearer token should not buy.
   */
  private async mapUpstreamFailure(upstream: Response): Promise<OpenAiApiError> {
    const detail = await readErrorDetail(upstream);
    this.logger.warn(`LiteLLM answered ${upstream.status}: ${detail || '(no detail)'}`);

    if (upstream.status === 429) {
      const retryAfter = upstream.headers.get('retry-after') ?? '1';
      return openAiErrors.rateLimited('The model backend is at capacity.', { 'Retry-After': retryAfter });
    }
    if (/context[ _-]?length|maximum context|too many tokens/i.test(detail)) {
      return openAiErrors.contextLengthExceeded(detail);
    }
    if (upstream.status >= 500 || upstream.status === 404) {
      return openAiErrors.backendUnavailable(`The model backend answered ${upstream.status}.`);
    }
    return openAiErrors.backendError(`The model backend rejected the request (${upstream.status}).`);
  }

  /**
   * Meters a request that never produced tokens, then hands the error back to
   * be thrown. A failed generation still belongs in the Logs screen — with
   * `status: error` and a cost of zero.
   */
  private async fail(context: GatewayContext, error: OpenAiApiError): Promise<OpenAiApiError> {
    await this.recorder.finish(context, {
      promptTokens: 0,
      completionTokens: 0,
      status: 'error',
      errorCode: error.code,
      finishReason: null,
      timeToFirstTokenMs: null,
    });
    return error;
  }
}

function bodyOf(request: ApiKeyRequest): Record<string, unknown> {
  const body = request.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw openAiErrors.invalidJson();
  }
  return body as Record<string, unknown>;
}

function headerOf(request: ApiKeyRequest, name: string): string | null {
  const value = request.headers[name];
  return typeof value === 'string' && value.length > 0 ? value.slice(0, 64) : null;
}

/** Did the client itself ask for the usage chunk? */
function usageRequested(body: Record<string, unknown>): boolean {
  const options = body.stream_options;
  return Boolean(options && typeof options === 'object' && (options as { include_usage?: unknown }).include_usage);
}

/**
 * The body LiteLLM receives: the client's, with `model` rewritten to the
 * upstream's name and — when the client streams without asking for usage — a
 * usage chunk requested on the router's behalf so the meter is exact rather
 * than estimated. The relay drops that chunk again before the client sees it.
 */
function upstreamBodyFor(context: GatewayContext): Record<string, unknown> {
  const body: Record<string, unknown> = { ...context.body, model: context.model.litellmModel };
  if (context.suppressUsageChunk) {
    const existing = (body.stream_options ?? {}) as Record<string, unknown>;
    body.stream_options = { ...existing, include_usage: true };
  }
  return body;
}

function finishReasonOfBody(payload: unknown): string | null {
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) {
    return null;
  }
  const reason = (choices[0] as { finish_reason?: unknown } | undefined)?.finish_reason;
  return typeof reason === 'string' ? reason : null;
}

function messageOf(error: unknown): string {
  return `The model backend is unreachable: ${error instanceof Error ? error.message : String(error)}`;
}

async function readErrorDetail(upstream: Response): Promise<string> {
  try {
    const text = (await upstream.text()).slice(0, 1000);
    const parsed: unknown = JSON.parse(text);
    const message = (parsed as { error?: { message?: unknown } })?.error?.message;
    return typeof message === 'string' ? message : text;
  } catch {
    return '';
  }
}
