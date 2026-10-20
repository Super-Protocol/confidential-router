import { OpenAiApiError, openAiErrors } from './openai-error.js';

/**
 * One reading of a non-2xx answer from an upstream, shared by both forward legs.
 *
 * LiteLLM in this cluster space and an external endpoint in someone else's
 * deployment fail in the same vocabulary, and the question the mapping answers is
 * always the same one: **whose fault is this, and can the caller act on it?**
 * Keeping the answer in one place is what stopped the two legs from drifting —
 * they had two copies of this table and the 4xx row was wrong in both (SUP-448).
 *
 * The rows, in the order they are tried:
 *
 * | upstream | router | why |
 * | --- | --- | --- |
 * | 429 | `429 rate_limit_exceeded` | capacity; retrying is the right move |
 * | a context-length message | `400 context_length_exceeded` | the caller sent too much |
 * | ≥ 500, or 404 | `502 backend_unavailable` | the upstream failed or is not there |
 * | 401 / 402 / 403 / 407 | `502 backend_error` | *our* credential or account, not the caller's |
 * | any other 4xx | that 4xx, `invalid_request_error` | the upstream read the request and called it invalid |
 *
 * The last row is the one SUP-448 is about. It used to be `502 backend_error`,
 * which tells every OpenAI-compatible SDK "transient, retry" about a request that
 * can never succeed — one malformed `tool_calls[].function.arguments` in a message
 * already in the history, and the session is dead with the gateway taking the
 * blame. A 4xx says "fix the request", which is the truth, and the upstream's own
 * wording goes with it because it is the only thing that names the bad field.
 *
 * That wording is forwarded only when the upstream put it in an error field. A
 * raw body is logged and nothing more — see `UpstreamErrorBody.structured`.
 */

/** How a leg names its upstream in a client-facing sentence. */
export type UpstreamName = 'The model backend' | 'The external model endpoint';

export interface UpstreamErrorBody {
  /**
   * The best reason available: a structured error message when the body carried
   * one, otherwise the raw body. Always safe to log; only forwarded to the client
   * when {@link UpstreamErrorBody.structured} says where it came from.
   */
  text: string;
  /**
   * Did {@link UpstreamErrorBody.text} come from an error field the upstream
   * filled in, rather than being the raw bytes of the body?
   *
   * The 4xx exception below rests on the body being *about the caller's request*,
   * and only a structured message is. A raw body on that path is as likely to be
   * an intermediary's HTML error page or a FastAPI `{"detail":[…]}` validation
   * dump — neither of which the caller can act on, and neither of which it should
   * be handed. So the raw text stays in the log and the client gets the
   * "gave no reason" sentence instead.
   */
  structured: boolean;
  /** The request field it named, when it named one. */
  param?: string;
  /** The parsed body, for a leg that reads more than the message out of it. */
  parsed: unknown;
}

/** Longest an upstream error body we keep; the rest goes to the log, not the client. */
const MAX_BODY_CHARS = 1000;

/**
 * A 4xx an OpenAI-compatible SDK retries by itself.
 *
 * Forwarded verbatim they would reproduce the very loop SUP-448 is about, so they
 * collapse to 400: whatever the upstream meant by them, a request it has already
 * called invalid does not become valid on a second send.
 */
const RETRIED_BY_SDKS = new Set([408, 409, 425]);

/** Statuses that mean the router's own credential or account, never the caller's. */
const OUR_CREDENTIAL = new Set([401, 402, 403, 407]);

const CONTEXT_LENGTH = /context[ _-]?length|maximum context|too many tokens/i;

/**
 * Reads an upstream error body without ever letting it throw.
 *
 * Three shapes, because the upstreams in play use all three: OpenAI's
 * `{ error: { message, param } }`, vLLM's flat `{ message, param, type }` — what
 * `qwen3-coder-next` actually answers a bad request with — and plain text, which
 * is what a proxy in front of either returns when it is the one refusing.
 */
export async function readUpstreamError(upstream: Response): Promise<UpstreamErrorBody> {
  let text = '';
  try {
    text = (await upstream.text()).slice(0, MAX_BODY_CHARS);
  } catch {
    return { text: '', structured: false, parsed: null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { text, structured: false, parsed: null };
  }

  const body = parsed as { error?: { message?: unknown; param?: unknown }; message?: unknown; param?: unknown } | null;
  const message = body?.error?.message ?? body?.message;
  const param = body?.error?.param ?? body?.param;
  const structured = typeof message === 'string' && message.length > 0;
  return {
    text: structured ? (message as string) : text,
    structured,
    ...(typeof param === 'string' && param ? { param } : {}),
    parsed,
  };
}

/**
 * The upstream's status and body as one of the router's own errors.
 *
 * `upstream` is read for its status and headers only — its body is `body`, which
 * the caller has already consumed via {@link readUpstreamError} because a leg may
 * need to look inside it first (the egress sidecar's fail-closed denial is a 503
 * that only its body distinguishes from an upstream's own).
 */
export function upstreamFailureOf(who: UpstreamName, upstream: Response, body: UpstreamErrorBody): OpenAiApiError {
  const { status } = upstream;

  if (status === 429) {
    const retryAfter = upstream.headers.get('retry-after') ?? '1';
    return openAiErrors.rateLimited(`${who} is at capacity.`, { 'Retry-After': retryAfter });
  }
  if (CONTEXT_LENGTH.test(body.text)) {
    return openAiErrors.contextLengthExceeded(body.text);
  }
  if (status >= 500 || status === 404) {
    return openAiErrors.backendUnavailable(`${who} answered ${status}.`);
  }
  if (OUR_CREDENTIAL.has(status)) {
    // Deliberately not forwarded as the caller's 401/403: the key it sent was
    // accepted here, and the one the upstream refused is the router's own.
    return openAiErrors.backendError(`${who} refused the credential the router sent (${status}).`);
  }
  if (status < 400) {
    // A redirect or a `304` on a POST: nothing the relay can carry, and nothing
    // the caller did.
    return openAiErrors.backendError(`${who} answered ${status}, which is not a response the router can relay.`);
  }
  return openAiErrors.upstreamRejectedRequest({
    who,
    status: RETRIED_BY_SDKS.has(status) ? 400 : status,
    upstreamStatus: status,
    // Structured wording only: see `UpstreamErrorBody.structured`. An HTML page
    // from an intermediary is not the upstream telling the caller what is wrong
    // with the request, and neither leg ever forwarded one.
    detail: body.structured ? body.text : '',
    param: body.param,
  });
}
