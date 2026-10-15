/**
 * The one POST both legs of the gateway make, and the one retry rule they share.
 *
 * Extracted when the external egress leg arrived (ADR-008 §4): LiteLLM and the
 * egress sidecar are different backends with different trust stories, but the
 * transport decision — how long to wait for an answer, and when a failure is
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
 * The router gave up waiting for the upstream's response headers.
 *
 * Distinct from {@link UpstreamUnavailableError} because it names a different
 * party: the upstream was reached and may well be generating right now. The
 * gateway turns this one into `upstream_timeout`, not `backend_unavailable`.
 */
export class UpstreamTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`The model backend did not start answering within ${secondsOf(timeoutMs)}.`);
    this.name = 'UpstreamTimeoutError';
  }
}

/**
 * The deadline as a client should read it: whole seconds at the scale a
 * deployment configures, and a decimal below one rather than the `0s` that
 * rounding a sub-second timeout would print into a user-facing message.
 */
function secondsOf(ms: number): string {
  const value = ms / 1000;
  return `${value >= 1 ? Math.round(value) : Number(value.toFixed(2))}s`;
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
  /**
   * Longest to wait for the upstream's **response headers** — the only thing a
   * deadline around `fetch` can actually bound.
   *
   * `fetch` resolves when the headers arrive, so one timer wrapped around it
   * covers three phases it cannot tell apart: getting the connection, uploading
   * the request, and the upstream producing something to answer with. For a
   * non-streaming completion that last phase is the *whole generation*, because
   * the headers and the body are flushed together.
   *
   * This used to be armed with the 5 s `connectTimeout` and named after it, which
   * made 5 s the ceiling on any `/v1` request's time-to-first-byte (SUP-339). It
   * is not a hypothetical ceiling: prod measured a 182 044-token prompt prefilling
   * in 10.9 s and a 16-way burst of 8 k-token prompts peaking at 7.2 s, both fine
   * on the direct path and both aborted here — then reported to the caller as
   * `backend_unavailable`, which sent operators to look at a healthy model.
   *
   * Nothing fast is lost by being patient: an upstream that is not listening fails
   * with `ECONNREFUSED` the moment the socket is attempted, on loopback and
   * in-cluster alike, so "the egress sidecar has not started that listener" still
   * surfaces immediately and needs no deadline to be noticed.
   */
  responseTimeoutMs: number;
  /** Aborted when the client hangs up or the read goes idle; owned by the caller. */
  signal: AbortSignal;
  /** Called before a retry, so each leg can log in its own words. */
  onRetry?: (attempt: number, attempts: number) => void;
}

export async function postToUpstream(call: UpstreamCall): Promise<Response> {
  const payload = JSON.stringify(call.body);

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    // A fresh controller per attempt: the response deadline belongs to the
    // attempt, the caller's signal to the whole request.
    const deadline = new AbortController();
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      deadline.abort(new Error('Upstream did not send its response headers in time.'));
    }, call.responseTimeoutMs);
    try {
      return await fetch(call.url, {
        method: 'POST',
        headers: call.headers,
        body: payload,
        signal: AbortSignal.any([call.signal, deadline.signal]),
      });
    } catch (error) {
      // The caller's abort wins over our own: a client that hung up is the
      // authoritative reason this request ended, whichever signal fired first.
      if (call.signal.aborted) {
        lastError = error;
        break;
      }
      if (expired) {
        lastError = new UpstreamTimeoutError(call.responseTimeoutMs);
        break;
      }
      lastError = new UpstreamUnavailableError(error);
      if (!isConnectionError(error) || attempt === MAX_ATTEMPTS) {
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
 * Whether the failure proves the upstream never took the request.
 *
 * `fetch` reports a transport failure as a `TypeError` and hides the detail in
 * `cause`, so the codes above are what "the connection never came up" looks
 * like. An `AbortError` — an abort raised with no reason — counts for the same
 * reason: nothing was sent.
 *
 * **A response-deadline expiry never reaches this function.** `postToUpstream`
 * recognises its own timer and breaks out as an `UpstreamTimeoutError` before
 * asking, so the deadline path does not retry. That is the conservative answer and
 * the one we want: the socket was accepted and the request bytes may already be on
 * it, so the upstream may have started generating. `MAX_ATTEMPTS` only ever covers
 * an attempt that provably never established. `upstream-fetch.spec.ts` pins this.
 */
export function isConnectionError(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') {
    return true;
  }
  const code = (error as { cause?: { code?: string } })?.cause?.code;
  return typeof code === 'string' && CONNECTION_ERROR_CODES.has(code);
}
