import type { Response as ExpressResponse } from 'express';
import type { GenerationStatus } from '../../db/entities/generation.entity.js';
import { computeCostMicros } from '../../metering/pricing.js';
import { estimatePromptTokens, estimateTokens } from '../../metering/token-estimator.js';
import type { GatewayContext, GenerationOutcome } from './gateway.types.js';
import { asOpenAiError, type OpenAiApiError } from './openai-error.js';
import { deltaTextOf, finishReasonOf, readUsage, shapeResponse, type UsageCounts } from './response-shaping.js';
import { dataPayloadOf, formatDataEvent, SSE_DONE, SSE_HEARTBEAT, splitSseEvents } from './sse.js';

/** `docs/contracts/router-api.md`: a comment line while waiting for the first token. */
export const HEARTBEAT_INTERVAL_MS = 15_000;

/** What a leg makes of a stream that broke after its headers were out. */
export interface StreamFailure {
  error: OpenAiApiError;
  /** What the meter should call it — `error`, or `aborted` when policy ended it. */
  status: GenerationStatus;
}

export interface StreamRelayInput {
  context: GatewayContext;
  /** The upstream response, already known to be a 2xx event stream. */
  upstream: Response;
  response: ExpressResponse;
  /** Longest gap between upstream chunks before the stream is abandoned. */
  readTimeoutMs: number;
  /** Aborts the upstream fetch on client hang-up or read timeout. */
  abort: AbortController;
  /** Overridable so a test does not have to wait a quarter of a minute. */
  heartbeatIntervalMs?: number;
  /**
   * How this leg explains a stream that died mid-flight. Defaults to "the router
   * failed", which is all the LiteLLM leg can honestly say about a dropped socket;
   * the external leg asks the sidecar and can report a withdrawn verdict instead
   * (ADR-008 §3, Denis's ruling 5).
   */
  failureMapper?: (failure: unknown) => Promise<StreamFailure>;
}

const DEFAULT_FAILURE_MAPPER = async (failure: unknown): Promise<StreamFailure> => ({
  error: asOpenAiError(failure),
  status: 'error',
});

/**
 * Forwards an SSE completion, event by event, as it arrives.
 *
 * The only buffering is inside one event, until its blank line: an event has to
 * be complete before its `id` and `model` can be rewritten to the router's, and
 * before the usage-only chunk can be given its `cost_micros` / `endpoint` /
 * `evidence_digest` extension. Everything the router does not understand —
 * heartbeats, `[DONE]`, non-JSON payloads — is passed through byte for byte.
 *
 * The return value is the meter: this function never writes to the database, so
 * the caller can record the same outcome whether the stream ended, failed or
 * was abandoned by the client.
 */
export async function relayStream(input: StreamRelayInput): Promise<GenerationOutcome> {
  const { context, upstream, response, abort } = input;

  let usage: UsageCounts | null = null;
  let completionEstimate = 0;
  let finishReason: string | null = null;
  let timeToFirstTokenMs: number | null = null;
  let sawDone = false;
  let aborted = false;
  /** The client hung up *after* `[DONE]`: the generation ended, the socket did not. */
  let leftAfterDone = false;

  writeStreamHeaders(response, context);

  let heartbeat: NodeJS.Timeout | undefined = setInterval(() => {
    if (!response.writableEnded) {
      response.write(SSE_HEARTBEAT);
    }
  }, input.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS);
  const stopHeartbeat = (): void => {
    clearInterval(heartbeat);
    heartbeat = undefined;
  };

  let idle: NodeJS.Timeout | undefined;
  const resetIdle = (): void => {
    clearTimeout(idle);
    idle = setTimeout(() => abort.abort(new Error('Upstream stopped sending data.')), input.readTimeoutMs);
  };

  // `close` also fires on a clean end; only an unfinished response means the
  // client walked away, and then there is no point in paying for more tokens.
  //
  // "Unfinished" is about the *generation*, not about the socket. `[DONE]` is
  // the last event of a completion, and a client that closes once it has read
  // one has the whole answer — which is precisely what the `openai` SDK does at
  // the end of `for await (… of stream)`. Calling that an abort made every
  // streamed generation from the official client, the console chat included,
  // land in Logs as `aborted`, and left ruling 5's `aborted` unable to mean what
  // it is for: a generation policy cut short.
  const onClose = (): void => {
    if (response.writableEnded) {
      return;
    }
    if (sawDone) {
      leftAfterDone = true;
    } else {
      aborted = true;
    }
    // The upstream fetch is cancelled either way: nothing more will be
    // forwarded, and a backend that holds the connection open past `[DONE]`
    // must not keep this relay waiting for its read deadline.
    abort.abort(new Error('Client closed the connection.'));
  };
  response.on('close', onClose);

  const emit = (event: string): void => {
    if (!response.writableEnded) {
      response.write(event);
    }
  };

  const handleEvent = (event: string): void => {
    const payload = dataPayloadOf(event);
    if (payload === null) {
      emit(event);
      return;
    }
    if (payload.trim() === '[DONE]') {
      sawDone = true;
      emit(SSE_DONE);
      return;
    }

    let chunk: unknown;
    try {
      chunk = JSON.parse(payload);
    } catch {
      // Not ours to interpret; the client gets exactly what the backend sent.
      emit(event);
      return;
    }
    if (!chunk || typeof chunk !== 'object') {
      emit(event);
      return;
    }

    const text = deltaTextOf(chunk);
    if (text.length > 0 && timeToFirstTokenMs === null) {
      timeToFirstTokenMs = Date.now() - context.startedAt;
      stopHeartbeat();
    }
    completionEstimate += estimateTokens(text);
    finishReason = finishReasonOf(chunk) ?? finishReason;

    const reported = readUsage(chunk);
    if (reported) {
      usage = reported;
    }
    if (reported && context.suppressUsageChunk && isUsageOnly(chunk)) {
      // The router asked for this chunk, not the client. Counted, not forwarded.
      return;
    }
    // Re-emitted as a single `data:` line: the OpenAI stream format uses no
    // `event:` or `id:` fields, and every event that is not a JSON object has
    // already been forwarded untouched above.
    const record = chunk as Record<string, unknown>;
    emit(
      formatDataEvent(
        JSON.stringify(shapeResponse(record, context, reported ? extensionFor(context, reported) : null)),
      ),
    );
  };

  const decoder = new TextDecoder();
  let buffer = '';
  let failure: unknown;

  try {
    const body = upstream.body;
    if (!body) {
      throw new Error('Upstream returned an event stream with no body.');
    }
    const reader = body.getReader();
    resetIdle();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      resetIdle();
      buffer += decoder.decode(value, { stream: true });
      const split = splitSseEvents(buffer);
      buffer = split.rest;
      for (const event of split.events) {
        handleEvent(event);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim().length > 0) {
      handleEvent(buffer.endsWith('\n\n') ? buffer : `${buffer}\n\n`);
    }
  } catch (error) {
    failure = error;
  } finally {
    clearTimeout(idle);
    stopHeartbeat();
    response.off('close', onClose);
  }

  if (leftAfterDone) {
    // The cancellation above surfaces as a read error on the upstream body. It
    // is this relay's own doing, on a generation that already completed.
    failure = undefined;
  }

  let errorCode: string | null = null;
  let meteredStatus: GenerationStatus = aborted ? 'aborted' : failure ? 'error' : 'ok';
  if (failure && !aborted) {
    // The status line is long gone, so the contract puts the error in the
    // stream: one last `data:` event carrying an OpenAI error object, then the
    // terminator the client is waiting for.
    const mapped = await (input.failureMapper ?? DEFAULT_FAILURE_MAPPER)(failure);
    errorCode = mapped.error.code;
    meteredStatus = mapped.status;
    emit(formatDataEvent(JSON.stringify(mapped.error.toBody())));
  }
  if (!sawDone && !aborted) {
    emit(SSE_DONE);
  }
  if (!response.writableEnded) {
    response.end();
  }

  const counts: UsageCounts = usage ?? {
    promptTokens: estimatePromptTokens(context.body),
    completionTokens: completionEstimate,
  };
  return {
    ...counts,
    status: meteredStatus,
    errorCode,
    finishReason,
    timeToFirstTokenMs,
  };
}

export function extensionFor(context: GatewayContext, counts: UsageCounts) {
  return {
    costMicros: computeCostMicros(counts, context.model),
    endpoint: context.model.endpoint.name,
    evidenceDigest: context.evidenceDigest,
  };
}

/** A usage-only chunk: `choices` present and empty, as OpenAI defines it. */
function isUsageOnly(chunk: unknown): boolean {
  const choices = (chunk as { choices?: unknown }).choices;
  return Array.isArray(choices) && choices.length === 0;
}

function writeStreamHeaders(response: ExpressResponse, context: GatewayContext): void {
  response.status(200);
  response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  // `no-transform` and the nginx hint together: any proxy that buffers this
  // response turns a token-by-token stream back into a single blob.
  response.setHeader('Cache-Control', 'no-cache, no-transform');
  response.setHeader('Connection', 'keep-alive');
  response.setHeader('X-Accel-Buffering', 'no');
  response.setHeader('X-Confidential-Router-Endpoint', context.model.endpoint.hostname);
  response.setHeader('X-Confidential-Router-Generation-Id', context.generationId);
  response.flushHeaders();
}
