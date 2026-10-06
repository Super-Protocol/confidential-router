/**
 * The one POST both legs of the gateway make, and the one retry rule they share.
 *
 * Extracted when the external egress leg arrived (ADR-008 §4): LiteLLM and the
 * egress sidecar are different backends with different trust stories, but the
 * transport decision — how long to wait for a connection, and when a failure is
 * safe to retry — is a property of *having sent nothing yet*, which is the same
 * on both. Two copies of it would be two chances to make a non-idempotent retry.
 */

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
export const MAX_ATTEMPTS = 2;

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

export interface UpstreamCall {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  connectTimeoutMs: number;
  /** Aborted when the client hangs up or the read goes idle; owned by the caller. */
  signal: AbortSignal;
  /** Called before a retry, so each leg can log in its own words. */
  onRetry?: (attempt: number, attempts: number) => void;
}

export async function postToUpstream(call: UpstreamCall): Promise<Response> {
  const payload = JSON.stringify(call.body);

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    // A fresh controller per attempt: the connect deadline belongs to the
    // attempt, the caller's signal to the whole request.
    const connect = new AbortController();
    const timer = setTimeout(
      () => connect.abort(new Error('Upstream did not accept the connection in time.')),
      call.connectTimeoutMs,
    );
    try {
      return await fetch(call.url, {
        method: 'POST',
        headers: call.headers,
        body: payload,
        signal: AbortSignal.any([call.signal, connect.signal]),
      });
    } catch (error) {
      lastError = call.signal.aborted ? error : new UpstreamUnavailableError(error);
      if (call.signal.aborted || !isConnectionError(error) || attempt === MAX_ATTEMPTS) {
        break;
      }
      call.onRetry?.(attempt, MAX_ATTEMPTS);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

/**
 * Whether the failure happened before the upstream took the request.
 *
 * `fetch` reports every transport failure as a `TypeError` and hides the
 * detail in `cause`; an abort from our own connect deadline arrives as an
 * `AbortError` and counts too, because nothing was sent either way.
 */
export function isConnectionError(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') {
    return true;
  }
  const code = (error as { cause?: { code?: string } })?.cause?.code;
  return typeof code === 'string' && CONNECTION_ERROR_CODES.has(code);
}
