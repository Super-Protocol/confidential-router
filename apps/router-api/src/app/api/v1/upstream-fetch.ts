/**
 * The one POST both legs of the gateway make, and the retry rules they share.
 *
 * Extracted when the external egress leg arrived (ADR-008 §4): LiteLLM and the
 * egress sidecar are different backends with different trust stories, but the
 * transport decision — how long to wait for an answer, and when a failure is
 * safe to retry — is a property of *having relayed nothing yet*, which is the
 * same on both. Two copies of it would be two chances to make a non-idempotent
 * retry.
 *
 * **A connection that never established** is retried on both legs; that is the
 * original rule and `MAX_ATTEMPTS` carries its argument.
 *
 * **A proxy-generated 5xx in the status line** is retried on the external leg
 * only, and only when the leg asks for it (`retryProxyFailure`) — see
 * `PROXY_FAILURE_STATUSES` for the evidence and `shouldRetryStatus` for the
 * four reasons not to. Nothing in either case has been relayed to the client
 * when this function decides: it returns before a byte of the upstream's body
 * is read.
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
 * whichever retryable failure caused it.
 *
 * It used to say the retry is safe because the connection "provably never
 * established", and that no longer covers every case: a proxy-generated 5xx
 * arrived over a connection that did establish. The argument that covers both is
 * about **what the answer carries**. A refused connection and a proxy's error
 * page both carry no `usage`, so no generation of theirs is ever metered and the
 * caller cannot be billed twice — `relayStream` and `completeOnce` meter the
 * attempt whose body is returned, and this function returns exactly one. The
 * cost of being wrong is therefore bounded at **one duplicate generation on our
 * own GPU**, never a duplicate charge; that is the trade SUP-917 accepted, and
 * it is why a `500` — which the model server produced itself, having read the
 * request — is still not retried.
 *
 * One attempt in total rather than one per cause: two causes with one each would
 * let a refused connection and a proxy 5xx compound into three round trips on a
 * request the caller is already waiting on.
 */
export const MAX_ATTEMPTS = 2;

/**
 * The statuses a proxy in front of the upstream writes when it could not get an
 * answer out of it, and `500` is pointedly not among them.
 *
 * Each of these three is a statement about the *path* rather than about the
 * model: `502` the proxy got nothing usable, `503` it had nowhere to send the
 * request, `504` it gave up waiting. In all three the model's answer, if it ever
 * produced one, did not come back — so there is nothing of it to contradict by
 * asking again. `500` is the opposite: the model server read the request and
 * failed on it, so a retry buys a second identical failure at the caller's
 * expense. 4xx likewise (SUP-448).
 *
 * `503` carries one exception, and it is the sharpest rule in this file: the
 * egress sidecar's own fail-closed denial is a `503`, and retrying an
 * attestation refusal is the one thing this helper must never do (ADR-008 §4).
 * Nothing on the wire separates it from a model server's `503` except its body,
 * so {@link isGatekeeperDenial} reads the body — off a clone, so the caller
 * still receives an unread one.
 *
 * Measured rather than assumed (SUP-917, 2026-11-25). Over 48 hours — and again
 * over a fresh 28-minute window afterwards — every `5xx` the model cloud's
 * gateway rendered for the production model endpoint was a `502` on
 * `POST /v1/chat/completions`, 21 of 21 through one of its three nodes, all at
 * `upstreamTime` 60.002–60.005 s. vLLM's own log shows it never received those
 * requests: no non-200, no abort, the engine idle through the whole minute. The
 * gateway does not retry them itself, by design, because from where it stands a
 * `5xx` from the ingress is the application's own answer (SUP-366). An immediate
 * replay of the identical body succeeded **3 of 3**, in 1.7–2.4 s, against first
 * attempts failing at 0.85 % — which is what this constant buys.
 *
 * This also closes the user-visible half of SUP-455 wherever the 60 s hop turns
 * out to be, because it is keyed on what the caller received and not on which
 * cloud produced it.
 */
const PROXY_FAILURE_STATUSES = new Set([502, 503, 504]);

/** Why a retry is happening, for the leg's log line and for nothing else. */
export type RetryCause =
  /** The connection never established — the original rule. */
  | { kind: 'unreachable' }
  /** A proxy in front of the upstream answered this, and relayed nothing. */
  | { kind: 'proxy-failure'; status: number };

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
   * Whether a proxy-generated 5xx from this upstream may be sent again
   * ({@link PROXY_FAILURE_STATUSES}). Opt-in, and only the **external** leg opts
   * in (SUP-917).
   *
   * The difference is what sits in front of the upstream. An external endpoint is
   * reached through another deployment's gateway and ingress, and those are the
   * hops the measured `502` comes from. LiteLLM is in this cluster space with
   * nothing in front of it, so a 5xx on that leg is LiteLLM's own answer about
   * *its* upstream — which may well have generated — and resending it would be
   * the non-idempotent retry this helper exists to avoid.
   */
  retryProxyFailure?: boolean;
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
   * Set once a proxy failure has been retried, and it changes what the next
   * attempt is allowed to spend.
   *
   * A refused connection costs nothing before it is known, so its retry keeps
   * the full deadline — the behaviour SUP-339 settled, untouched here. A proxy
   * 5xx can arrive a minute in, and a second full deadline would let one request
   * spend twice what the deployment configured: the measured failure takes 60 s,
   * so two of them would be ~120 s against a 125 s deadline. This retry is
   * therefore given what is **left** of the original budget, and
   * {@link shouldRetryStatus} has already refused to start it unless that is
   * enough for a whole further attempt.
   */
  let boundedByBudget = false;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const attemptTimeoutMs = boundedByBudget
      ? Math.max(1, call.responseTimeoutMs - elapsedMs(startedAt))
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
      const attemptStartedAt = Date.now();
      const response = await fetch(call.url, {
        method: 'POST',
        headers: call.headers,
        body: payload,
        signal: AbortSignal.any([call.signal, deadline.signal]),
      });
      if (!(await shouldRetryStatus({ response, attempt, call, startedAt, attemptStartedAt }))) {
        return response;
      }
      // The discarded attempt's body is released rather than left to the garbage
      // collector: undici holds the connection until it is read or cancelled,
      // and this path runs on a backend that is already struggling.
      await response.body?.cancel().catch(() => undefined);
      // Re-asked after the cancel, which yields: a client that left during it is
      // a client the retry has nobody to answer.
      if (call.signal.aborted) {
        return response;
      }
      boundedByBudget = true;
      call.onRetry?.(attempt, MAX_ATTEMPTS, { kind: 'proxy-failure', status: response.status });
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
      call.onRetry?.(attempt, MAX_ATTEMPTS, { kind: 'unreachable' });
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
 * Whether this answer is a proxy failure worth sending the request once more.
 *
 * Five reasons not to, and every one of them hands the caller the answer it
 * already has rather than a later one: the leg did not ask for this
 * (`retryProxyFailure`), the status is not one a proxy writes about a path, the
 * attempts are spent, the caller has hung up so there is nobody to answer, or
 * **what is left of the budget cannot fit another attempt the size of the one
 * that just failed**.
 *
 * That last rule is measured rather than chosen. The failure this exists for
 * takes 60 s, and a second one would take 60 s more: against a 125 s deadline
 * the retry fits, and against a shorter one it does not. Comparing the remaining
 * budget with *this* attempt's own duration says so without a magic number, and
 * it is what stops a retry turning a clean `502` the caller could act on into an
 * `upstream_timeout` that tells them less.
 *
 * Async only for the `503` exception, which has to look in the body.
 */
async function shouldRetryStatus(answer: {
  response: Response;
  attempt: number;
  call: Pick<UpstreamCall, 'responseTimeoutMs' | 'signal' | 'retryProxyFailure'>;
  startedAt: number;
  attemptStartedAt: number;
}): Promise<boolean> {
  const { response, attempt, call, startedAt, attemptStartedAt } = answer;
  if (!call.retryProxyFailure || !PROXY_FAILURE_STATUSES.has(response.status)) {
    return false;
  }
  if (attempt >= MAX_ATTEMPTS || call.signal.aborted) {
    return false;
  }
  const attemptMs = Date.now() - attemptStartedAt;
  if (call.responseTimeoutMs - elapsedMs(startedAt) < attemptMs) {
    return false;
  }
  return !(await isGatekeeperDenial(response));
}

/**
 * Is this `503` the egress sidecar refusing on policy, rather than an upstream's
 * own `503`?
 *
 * The sidecar's fail-closed denial carries `error.type: "gatekeeper_error"`
 * (`writeDenial` in `pkg/proxy/handler.go`) and nothing else on the wire
 * distinguishes the two — which is why `ExternalUpstreamClient.mapFailure` reads
 * the body for the same reason one hop later. Read off a **clone**, so the body
 * the caller gets is still unread; the clone is consumed to completion rather
 * than left holding a connection.
 *
 * Unreadable, unparseable or simply not a denial all answer `false`: the only
 * thing that stops a retry here is positive evidence of a policy refusal.
 */
async function isGatekeeperDenial(response: Response): Promise<boolean> {
  if (response.status !== 503) {
    return false;
  }
  try {
    const body = (await response.clone().json()) as { error?: { type?: unknown } } | null;
    return body?.error?.type === 'gatekeeper_error';
  } catch {
    return false;
  }
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
