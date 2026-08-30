import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { routerConfig } from '../../config.js';

export interface UpstreamRequest {
  /** OpenAI path, forwarded verbatim: `/v1/chat/completions` and friends. */
  path: string;
  body: unknown;
  /** Correlates the upstream's own logs with our `Generation` row. */
  generationId: string;
  stream: boolean;
  /** Aborted when the client hangs up or the read goes idle. */
  signal: AbortSignal;
}

/** The upstream could not be reached at all — as opposed to answering badly. */
export class UpstreamUnavailableError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'UpstreamUnavailableError';
    this.cause = cause;
  }
}

/**
 * One connection attempt is retried, and only when the first never established.
 *
 * Retrying anything else would re-run a generation the model may already have
 * started — expensive, non-idempotent and, for a streaming request, impossible
 * once a byte has left.
 */
const MAX_ATTEMPTS = 2;

const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/**
 * The router's only outbound dependency: LiteLLM, in the same confidential
 * cluster, over plain HTTP (ADR-002 §4).
 *
 * Bodies are passed through untouched apart from `model`, which the caller has
 * already rewritten to the upstream's name. The router does not inspect
 * `messages` — not here, not anywhere.
 */
@Injectable()
export class LiteLlmClient {
  private readonly logger = new Logger(LiteLlmClient.name);

  constructor(@Inject(routerConfig.KEY) private readonly config: ConfigType<typeof routerConfig>) {}

  /** Longest the relay waits between upstream chunks; owned here with the rest of the backend config. */
  get readTimeoutMs(): number {
    return this.config.backends.litellm.readTimeout;
  }

  async send(request: UpstreamRequest): Promise<Response> {
    const { baseUrl, apiKey, connectTimeout } = this.config.backends.litellm;
    const url = `${baseUrl.replace(/\/+$/, '')}${request.path}`;

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: request.stream ? 'text/event-stream' : 'application/json',
      'x-litellm-metadata': JSON.stringify({ generation_id: request.generationId }),
    };
    if (apiKey) {
      headers.authorization = `Bearer ${apiKey}`;
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      // A fresh controller per attempt: the connect deadline belongs to the
      // attempt, the caller's signal to the whole request.
      const connect = new AbortController();
      const timer = setTimeout(
        () => connect.abort(new Error('Upstream did not accept the connection in time.')),
        connectTimeout,
      );
      try {
        return await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(request.body),
          signal: AbortSignal.any([request.signal, connect.signal]),
        });
      } catch (error) {
        lastError = request.signal.aborted ? error : new UpstreamUnavailableError(error);
        if (request.signal.aborted || !isConnectionError(error) || attempt === MAX_ATTEMPTS) {
          break;
        }
        this.logger.warn(`LiteLLM ${url} unreachable (attempt ${attempt}/${MAX_ATTEMPTS}); retrying.`);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError;
  }
}

/**
 * Whether the failure happened before the upstream took the request.
 *
 * `fetch` reports every transport failure as a `TypeError` and hides the
 * detail in `cause`; an abort from our own connect deadline arrives as an
 * `AbortError` and counts too, because nothing was sent either way.
 */
function isConnectionError(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') {
    return true;
  }
  const code = (error as { cause?: { code?: string } })?.cause?.code;
  return typeof code === 'string' && CONNECTION_ERROR_CODES.has(code);
}
