import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import type { Response as ExpressResponse } from 'express';
import type { AuthenticatedApiKey } from '../../api-keys/index.js';
import { bridgesCompletions } from '../../catalog/served-capabilities.js';
import { routerConfig } from '../../config.js';
import { estimatePromptTokens } from '../../metering/token-estimator.js';
import { generationId } from '../../metering/ulid.js';
import { type ApiKeyRequest, apiKeyOf } from './api-key.guard.js';
import { clientOf } from './client-dimension.js';
import { chatBodyForPrompt, textCompletionOf } from './completions-bridge.js';
import { ExternalUpstreamClient } from './external-upstream.client.js';
import type { ExternalRoute, GatewayContext, GenerationOutcome, RoutedModel, RouteKind } from './gateway.types.js';
import { UPSTREAM_PATHS } from './gateway.types.js';
import { GatewayAnalytics } from './gateway-analytics.service.js';
import { GatewayPolicyService } from './gateway-policy.service.js';
import { GenerationRecorder } from './generation-recorder.service.js';
import { LiteLlmClient } from './litellm.client.js';
import { requestedModelSlug, resultOf } from './model-demand.js';
import { OpenAiApiError, openAiErrors } from './openai-error.js';
import { readUsage, shapeResponse } from './response-shaping.js';
import { formatDataEvent, SSE_DONE } from './sse.js';
import {
  extensionFor,
  HEARTBEAT_INTERVAL_MS,
  openStreamIfSlow,
  type PendingStream,
  relayStream,
  type StreamFailure,
} from './stream-relay.js';
import { describeUpstreamError, readUpstreamError, upstreamFailureOf } from './upstream-failure.js';
import { UpstreamTimeoutError } from './upstream-fetch.js';

/** A model resolved to the external leg, narrowed so `external` is not optional. */
type ExternalModel = RoutedModel & { external: ExternalRoute };

/**
 * The `/v1` request path, end to end: admit, forward, shape, meter.
 *
 * Written as one readable sequence on purpose — the order of admission checks,
 * the point at which a generation id is minted, and the guarantee that every
 * forwarded request produces exactly one metering row are the properties this
 * file exists to make obvious.
 *
 * There are two forward targets and exactly one seam between them (ADR-008 §4):
 * LiteLLM, in this cluster space, and the attesting egress sidecar for a model in
 * someone else's deployment. Everything else here — rate limits, the generation
 * id, the no-content invariant, the SSE relay, response shaping — runs the same
 * code for both, which is the property the external leg was required not to
 * disturb.
 */
@Injectable()
export class GatewayService {
  private readonly logger = new Logger(GatewayService.name);

  // biome-ignore lint/complexity/useMaxParams: a Nest DI constructor has no call site to keep readable.
  constructor(
    @Inject(routerConfig.KEY) private readonly config: ConfigType<typeof routerConfig>,
    private readonly policy: GatewayPolicyService,
    private readonly recorder: GenerationRecorder,
    private readonly upstream: LiteLlmClient,
    private readonly external: ExternalUpstreamClient,
    private readonly productAnalytics: GatewayAnalytics,
  ) {}

  async handle(request: ApiKeyRequest, response: ExpressResponse, kind: RouteKind): Promise<void> {
    const auth = apiKeyOf(request);
    const body = bodyOf(request);
    const model = this.resolveAndReport(kind, body, auth);
    // The legacy route for a chat-only model is served here rather than refused
    // (SUP-450): the prompt becomes a chat request, and the answer is translated
    // back on the way out. Beside `resolve` and before `admit`, because an
    // untranslatable legacy parameter is a request shape the router rejects —
    // the same class of 400 as `n > 1`, and it should cost no rate-limit slot
    // and leave no metering row.
    const bridged = kind === 'completions' && bridgesCompletions(model.capabilities);
    const upstreamBody = bridged ? chatBodyForPrompt(body) : body;
    const rateLimitHeaders = await this.policy.admit(auth);

    const start = await this.recorder.begin(model);
    const stream = kind !== 'embeddings' && body.stream === true;
    const clientWantsUsage = usageRequested(body);

    const context: GatewayContext = {
      kind,
      generationId: start.id,
      model,
      auth,
      body: upstreamBody,
      stream,
      upstreamPath: bridged ? UPSTREAM_PATHS.chat : UPSTREAM_PATHS[kind],
      bridged,
      suppressUsageChunk: stream && !clientWantsUsage,
      coverage: start.coverage,
      evidenceDigest: start.evidenceDigest,
      rateLimitHeaders,
      requestId: headerOf(request, 'x-request-id'),
      clientIp: request.ip ?? null,
      client: clientOf(request.headers),
      startedAt: Date.now(),
    };

    for (const [header, value] of Object.entries(rateLimitHeaders)) {
      response.setHeader(header, value);
    }
    if (context.requestId) {
      response.setHeader('X-Request-Id', context.requestId);
    }

    const leg = externalOf(model);
    const abort = new AbortController();

    // A streamed request that waits too long gets its stream opened anyway, so
    // the router rather than an impatient proxy decides how this request ends.
    // The cadence is shared with the relay that takes over: an operator who
    // tunes the delay down for a tight ingress tunes the whole stream's silence
    // down with it.
    const keepAliveAfterMs = this.config.server.streamKeepAliveAfter;
    const heartbeatIntervalMs = Math.min(HEARTBEAT_INTERVAL_MS, keepAliveAfterMs);
    const pending = stream
      ? openStreamIfSlow({ context, response, openAfterMs: keepAliveAfterMs, heartbeatIntervalMs })
      : null;

    // The client's socket is watched from here, not from `relayStream`: the
    // window SUP-449 lives in is the one *before* the upstream answers, and a
    // hang-up there left the fetch running with nothing watching it.
    //
    // Streamed requests only. A non-streamed completion that is cancelled
    // mid-flight is still finished and metered as it always was: its tokens were
    // produced whether or not anyone is left to read them, and `aborted` is
    // defined in streaming terms (`docs/contracts/router-api.md`).
    let clientLeft = false;
    const onClose = (): void => {
      if (response.writableEnded) {
        return;
      }
      clientLeft = true;
      abort.abort(new Error('Client closed the connection.'));
    };
    if (stream) {
      response.on('close', onClose);
    }
    /** Hands the socket back to whoever runs next — the relay, or nobody. */
    const releaseSocket = (): void => {
      pending?.stop();
      response.off('close', onClose);
    };

    let upstreamResponse: Response;
    try {
      upstreamResponse = leg
        ? await this.external.send({
            model: leg,
            path: context.upstreamPath,
            body: upstreamBodyFor(context),
            stream,
            signal: abort.signal,
          })
        : await this.upstream.send({
            path: context.upstreamPath,
            body: upstreamBodyFor(context),
            generationId: context.generationId,
            stream,
            signal: abort.signal,
          });
    } catch (error) {
      releaseSocket();
      if (clientLeft) {
        return this.recordAbandoned(context);
      }
      // Nothing was forwarded, and which failure this was decides who the caller
      // is told to look at — see `transportFailureOf`.
      return this.endBeforeTokens({ context, response, pending }, transportFailureOf(error));
    }
    releaseSocket();
    if (clientLeft) {
      // The hang-up and the upstream's headers crossed. Nothing failed and
      // nobody is left to tell, so this is the same `aborted` as a hang-up one
      // tick earlier — not the `error` the relay would read off a body the
      // abort has already torn down.
      void upstreamResponse.body?.cancel().catch(() => undefined);
      return this.recordAbandoned(context);
    }

    if (!upstreamResponse.ok) {
      const error = leg
        ? await this.external.mapFailure(leg, upstreamResponse)
        : await this.mapUpstreamFailure(upstreamResponse);
      return this.endBeforeTokens({ context, response, pending }, error);
    }

    const outcome = stream
      ? await relayStream({
          context,
          upstream: upstreamResponse,
          response,
          readTimeoutMs: leg ? this.external.readTimeoutMs : this.upstream.readTimeoutMs,
          abort,
          heartbeatIntervalMs,
          failureMapper: leg
            ? (failure): Promise<StreamFailure> => this.external.classifyStreamFailure(leg, failure)
            : undefined,
        })
      : await this.completeOnce(context, upstreamResponse, response);

    await this.policy.settle(auth.key, outcome.promptTokens + outcome.completionTokens);
    await this.recorder.finish(context, outcome);
  }

  /**
   * Admission, with the one thing it refuses reported as demand (SUP-542).
   *
   * The refusals are the point. `unknown_model` — somebody asked for a model we
   * do not serve — is the whole roadmap signal, and it is the one outcome that
   * leaves no row anywhere else: `resolve` throws before a generation id exists,
   * so without this the request is invisible to everything but the caller's own
   * 404. An event emitted only on the success path would answer "which of our
   * models is popular" and nothing about demand we are missing.
   *
   * Reported from the error the admission path threw rather than re-derived, so
   * the chart and the status code the caller received cannot disagree about why a
   * request was refused. `void`, never awaited: a refusal must not be answered
   * more slowly because of a chart.
   */
  private resolveAndReport(kind: RouteKind, body: Record<string, unknown>, auth: AuthenticatedApiKey): RoutedModel {
    const slug = requestedModelSlug(body);
    const at = new Date();
    try {
      const model = this.policy.resolve(kind, body, auth.key);
      if (slug) {
        void this.productAnalytics.modelRequested({
          workspaceId: auth.workspace.id,
          // Its own id: the generation the recorder is about to open has not been
          // minted yet, and the event is about the request rather than the row.
          generationId: generationId(),
          modelSlug: slug,
          result: 'served',
          route: kind,
          at,
        });
      }
      return model;
    } catch (error) {
      const result = slug ? resultOf(error) : null;
      if (slug && result) {
        void this.productAnalytics.modelRequested({
          workspaceId: auth.workspace.id,
          generationId: generationId(),
          modelSlug: slug,
          result,
          route: kind,
          at,
        });
      }
      throw error;
    }
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
    // Translated before shaping, so the identity rewrite and the usage extension
    // land on the object the client will actually read.
    const body = context.bridged
      ? textCompletionOf(payload as Record<string, unknown>)
      : (payload as Record<string, unknown>);
    const shaped = shapeResponse(body, context, extensionFor(context, counts));

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
   * Maps a backend failure onto the router's error table — see
   * `upstream-failure.ts`, which holds the table both legs read.
   *
   * Still conservative about whose fault a failure is: a misconfigured LiteLLM key
   * or a crashed worker stays a 502, because telling the caller it made a bad
   * request would be a lie. What changed with SUP-448 is the converse — a 4xx
   * LiteLLM raised *about the request body* is now reported as a 4xx, with its
   * wording, because nothing else in the chain knows which field is wrong.
   *
   * That wording reaches the caller and not the log: a refusal quotes the field
   * it refused, so the line carries `describeUpstreamError`'s content-free
   * summary instead (SUP-497).
   */
  private async mapUpstreamFailure(upstream: Response): Promise<OpenAiApiError> {
    const body = await readUpstreamError(upstream);
    this.logger.warn(`LiteLLM answered ${upstream.status}: ${describeUpstreamError(body)}`);
    return upstreamFailureOf('The model backend', upstream, body);
  }

  /**
   * Ends a request that failed before a single token, by whichever channel is
   * still open.
   *
   * Normally that is the status line, and the error is thrown for the filter to
   * render as a 502/503/504. Once the keep-alive stream has been opened there is
   * no status line left, so the error goes where a mid-stream failure already
   * goes: one last `data:` event carrying the OpenAI error object, then the
   * terminator the client is waiting for. Either way exactly one metering row is
   * written, which is the half of SUP-423 the router owns.
   */
  private async endBeforeTokens(
    ending: { context: GatewayContext; response: ExpressResponse; pending: PendingStream | null },
    error: OpenAiApiError,
  ): Promise<void> {
    const { context, response, pending } = ending;
    if (!pending?.opened) {
      throw await this.fail(context, error);
    }
    // The stream is closed before the row is written, not after: a metering
    // failure must not leave the client with a truncated stream carrying neither
    // the error object nor the terminator it is waiting for.
    if (!response.writableEnded) {
      response.write(formatDataEvent(JSON.stringify(error.toBody())));
      response.write(SSE_DONE);
      response.end();
    }
    await this.fail(context, error);
  }

  /**
   * Meters a request whose client hung up before the upstream answered.
   *
   * `aborted` with no `errorCode`, the same thing the relay records for a client
   * that leaves mid-stream (`docs/contracts/router-api.md`): nothing failed, the
   * caller simply stopped waiting. Without this the request left Logs with no row
   * at all — the reporting gap three of the seven SUP-449 stalls fell into, once
   * the ingress had closed the socket under a request the router was still
   * serving.
   */
  private async recordAbandoned(context: GatewayContext): Promise<void> {
    await this.recorder.finish(context, {
      promptTokens: 0,
      completionTokens: 0,
      status: 'aborted',
      errorCode: null,
      finishReason: null,
      timeToFirstTokenMs: null,
    });
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

/** Narrows a resolved model to the external leg, or null for the LiteLLM one. */
function externalOf(model: RoutedModel): ExternalModel | null {
  return model.external ? ({ ...model, external: model.external } as ExternalModel) : null;
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
 * The body the upstream receives — LiteLLM's or an external endpoint's, the rule
 * is the same: the client's, with `model` rewritten to the name *that* upstream
 * knows, and — when the client streams without asking for usage — a usage chunk
 * requested on the router's behalf so the meter is exact rather than estimated.
 * The relay drops that chunk again before the client sees it.
 */
function upstreamBodyFor(context: GatewayContext): Record<string, unknown> {
  const body: Record<string, unknown> = { ...context.body, model: context.model.upstreamModel };
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

/**
 * Which party a failure before the response headers belongs to.
 *
 * Three answers, and keeping them apart is the whole point (SUP-339). A leg that
 * already decided — the egress sidecar's refusal, an unopenable envelope — keeps
 * its own; wrapping that would turn "this router is misconfigured" into "the
 * backend is down". A deadline expiry says the router stopped waiting, so it must
 * not read "unreachable": the upstream took the request and may be generating, and
 * calling that unreachable is what sent operators to inspect a model deployment
 * that was answering the same prompt fine one hop over. Only a genuine transport
 * failure — refused, reset, unresolvable — is `backend_unavailable`.
 */
function transportFailureOf(error: unknown): OpenAiApiError {
  if (error instanceof OpenAiApiError) {
    return error;
  }
  if (error instanceof UpstreamTimeoutError) {
    return openAiErrors.upstreamTimeout(error.message);
  }
  return openAiErrors.backendUnavailable(
    `The model backend is unreachable: ${error instanceof Error ? error.message : String(error)}`,
  );
}
