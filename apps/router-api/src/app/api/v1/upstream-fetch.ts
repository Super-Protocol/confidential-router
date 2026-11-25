/**
 * The one POST both legs of the gateway make, and the one retry rule they share.
 *
 * Extracted when the external egress leg arrived (ADR-008 §4): LiteLLM and the
 * egress sidecar are different backends with different trust stories, but the
 * transport decision — how long to wait for an answer, and when a failure is
 * safe to retry — is a property of *having relayed nothing yet*, which is the
 * same on both. Two copies of it would be two chances to make a non-idempotent
 * retry.
 *
 * Two failures are retried, and they have the same justification rather than
 * two: at the moment this function decides, **not one byte of the upstream's
 * body has been read**, so whatever it does next the caller has received
 * nothing. A connection that never established (below) is the original case. A
 * `502` is the one added on SUP-917, and `RETRYABLE_STATUS` is where the
 * evidence for it lives.
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
 * Total attempts for one upstream POST — the original plus at most one retry,
 * whichever of the two retryable failures caused it.
 *
 * Deliberately not per-cause: two causes with one attempt each would let a
 * refused connection and a gateway `502` compound into three round trips on a
 * request the caller is already waiting on.
 */
export const MAX_ATTEMPTS = 2;

/**
 * The one status that is retried, and why it is safe when `500` is not.
 *
 * `502` is what a proxy writes when it could not get a usable response out of
 * the thing behind it. It is therefore a statement about the *path*, not about
 * the model: the upstream that would have generated never answered, so there is
 * no generation to run twice. `500` is the opposite — the model server
 * considered the request and failed on it — and retrying that buys a second
 * identical failure at the caller's expense. `503` is excluded for a sharper
 * reason: the egress sidecar's fail-closed denial is a `503`, and retrying an
 * attestation refusal is the one thing this helper must never do (ADR-008 §4).
 *
 * Measured rather than assumed (SUP-917, 2026-11-25). Over 48 hours every `5xx`
 * the model cloud's gateway rendered for the production model endpoint was a
 * `502` on `POST /v1/chat/completions`, all of them through one of its three
 * nodes, all at `upstreamTime` 60.003–60.005 s — and vLLM's own log shows it
 * never received those requests: no non-200, no abort, the engine idle through
 * the whole minute. The gateway does not retry them itself, by design, because
 * from where it stands a `5xx` from the ingress is the application's own answer
 * (SUP-366). With three candidate peers and one of them bad, one retry here
 * takes a measured ~1 % per-call failure rate to ~0.01 %.
 *
 * This also closes the user-visible half of SUP-455 wherever the 60 s hop turns
 * out to be, because it is keyed on what the caller received and not on which
 * cloud produced it.
 */
const RETRYABLE_STATUS = 502;

/**
 * Least time a `502` retry may be given before it is not worth starting.
 *
 * A dead target refuses inside the connect timeout, and a healthy one answers a
 * normal completion in a couple of seconds, so ten seconds is room for the
 * retry to succeed. Below it the retry can only turn a `502` the caller already
 * has into the same `502` later, which is worse than handing over the first one.
 */
export const MIN_RETRY_BUDGET_MS = 10_000;

/** Which of the two retryable failures is being retried, for the leg's log line. */
export type RetryCause = 'unreachable' | 'bad-gateway';

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
  /**
   * Called before a retry, so each leg can log in its own words.
   *
   * `cause` is passed because the two failures need different sentences: "the
   * listener did not accept the connection" is a lie about a `502`, and an
   * operator reading it would go and look at the wrong hop.
   */
  onRetry?: (attempt: number, attempts: number, cause: RetryCause) => void;
}

export async function postToUpstream(call: UpstreamCall): Promise<Response> {
  const payload = JSON.stringify(call.body);
  const startedAt = Date.now();

  let lastError: unknown;
  /**
   * Set once a `502` has been retried, and it changes what the next attempt is
   * allowed to spend.
   *
   * A connection failure costs nothing before it is known, so its retry keeps
   * the full deadline — that is the behaviour SUP-339 settled and this does not
   * touch it. A `502` can arrive a minute in, and giving its retry a second full
   * deadline would let one request spend twice what the deployment configured.
   * So that retry is bounded by what is left of the original budget instead,
   * which `MIN_RETRY_BUDGET_MS` has already proved is enough to be worth having.
   */
  let boundedByBudget = false;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const attemptTimeoutMs = boundedByBudget
      ? Math.max(MIN_RETRY_BUDGET_MS, call.responseTimeoutMs - elapsedMs(startedAt))
      : call.responseTimeoutMs;
    // A fresh controller per attempt: the response deadline belongs to the
    // attempt, the caller's signal to the whole request.
    const deadline = new AbortController();
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      deadline.abort(new Error('Upstream did not send its response headers in time.'));
    }, attemptTimeoutMs);
    try {
      const response = await fetch(call.url, {
        method: 'POST',
        headers: call.headers,
        body: payload,
        signal: AbortSignal.any([call.signal, deadline.signal]),
      });
      if (!shouldRetryStatus({ status: response.status, attempt, call, startedAt })) {
        return response;
      }
      // The discarded attempt's body is released rather than left to the garbage
      // collector: undici holds the connection until it is read or cancelled,
      // and this path runs on a backend that is already struggling.
      await response.body?.cancel().catch(() => undefined);
      boundedByBudget = true;
      call.onRetry?.(attempt, MAX_ATTEMPTS, 'bad-gateway');
    } catch (error) {
      // The caller's abort wins over our own: a client that hung up is the
      // authoritative reason this request ended, whichever signal fired first.
      if (call.signal.aborted) {
        lastError = error;
        break;
      }
      if (expired) {
        // `attemptTimeoutMs`, not the configured value: on a budget-bounded
        // retry they differ, and the sentence this becomes is shown to the
        // caller. It should say how long we actually waited.
        lastError = new UpstreamTimeoutError(attemptTimeoutMs);
        break;
      }
      lastError = new UpstreamUnavailableError(error);
      if (!isConnectionError(error) || attempt === MAX_ATTEMPTS) {
        break;
      }
      call.onRetry?.(attempt, MAX_ATTEMPTS, 'unreachable');
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

function elapsedMs(startedAt: number): number {
  return Date.now() - startedAt;
}

/**
 * Whether this answer is a `502` worth sending the request once more.
 *
 * Four reasons not to, and each of them hands the caller the `502` it already
 * has rather than a later one: the status is anything else, the attempts are
 * spent, the caller has hung up so there is nobody to answer, or too little of
 * the budget is left for a retry to plausibly finish.
 */
function shouldRetryStatus(answer: {
  status: number;
  attempt: number;
  call: Pick<UpstreamCall, 'responseTimeoutMs' | 'signal'>;
  startedAt: number;
}): boolean {
  const { status, attempt, call, startedAt } = answer;
  if (status !== RETRYABLE_STATUS || attempt >= MAX_ATTEMPTS || call.signal.aborted) {
    return false;
  }
  return call.responseTimeoutMs - elapsedMs(startedAt) >= MIN_RETRY_BUDGET_MS;
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
