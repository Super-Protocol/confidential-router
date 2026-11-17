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
 * | a context-length message | `400 context_length_exceeded` | the caller sent too much — any status, see `CONTEXT_LENGTH` |
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
 * That wording is forwarded only when the upstream put it in an error field; a
 * raw body is withheld — see `UpstreamErrorBody.structured`.
 *
 * Neither is logged. A model server refusing a request quotes the field it
 * refused, so a 4xx body is one of the few places on this path where prompt
 * text can turn up in something durable, and `/privacy` §5 says it does not.
 * {@link describeUpstreamError} is what the log gets instead: the status, the
 * structured `type` and `param` when there was one, and how long the body was
 * (SUP-497).
 */

/** How a leg names its upstream in a client-facing sentence. */
export type UpstreamName = 'The model backend' | 'The external model endpoint';

export interface UpstreamErrorBody {
  /**
   * The best reason available: a structured error message when the body carried
   * one, otherwise the raw body. Forwarded to the client only when
   * {@link UpstreamErrorBody.structured} says where it came from — and never
   * logged, whichever it is: see {@link describeUpstreamError}.
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
   * be handed. So the raw text is dropped and the client gets the "gave no
   * reason" sentence instead.
   */
  structured: boolean;
  /** The request field it named, when it named one. */
  param?: string;
  /** The error class it named, when it named one — OpenAI's `error.type`. */
  type?: string;
  /**
   * How many characters the body was, before the {@link MAX_BODY_CHARS} cap.
   *
   * The one thing about a body worth having in a log: it separates "the upstream
   * said nothing" from "the upstream wrote a page we decided not to keep", which
   * is the difference between a dead backend and a rejected request.
   */
  length: number;
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

/**
 * The one row that reads an **unstructured** body, deliberately.
 *
 * Everywhere else a raw body is logged and withheld (`UpstreamErrorBody.structured`)
 * because it is as likely to be an intermediary's error page as anything about the
 * request. Here the regex is itself the filter: a body saying `maximum context` or
 * `too many tokens` is about the request by construction, some upstreams answer it
 * in plain text rather than JSON, and the numbers in that sentence — the limit and
 * what was asked for — are the one detail the caller can act on. Gating it would
 * buy consistency and cost the only thing worth forwarding.
 *
 * The consequence, named so it is a decision and not a surprise: an unstructured
 * body that matches this regex becomes `400 context_length_exceeded` whatever
 * status carried it, a 5xx included. That was already true on the egress leg,
 * whose reader always returned the raw text; it is newly reachable on the LiteLLM
 * leg, whose old reader returned `''` for any body it could not parse as JSON and
 * so never matched. A model server reporting a context overflow in an HTML 500 is
 * better described to the caller by this row than by `backend_unavailable`.
 */
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
  let raw = '';
  try {
    raw = await upstream.text();
  } catch {
    return { text: '', structured: false, length: 0, parsed: null };
  }

  const length = raw.length;
  const text = raw.slice(0, MAX_BODY_CHARS);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { text, structured: false, length, parsed: null };
  }

  const body = parsed as {
    error?: { message?: unknown; param?: unknown; type?: unknown };
    message?: unknown;
    param?: unknown;
    type?: unknown;
  } | null;
  const message = body?.error?.message ?? body?.message;
  const param = body?.error?.param ?? body?.param;
  const type = body?.error?.type ?? body?.type;
  const structured = typeof message === 'string' && message.length > 0;
  return {
    text: structured ? (message as string) : text,
    structured,
    ...(typeof param === 'string' && param ? { param } : {}),
    ...(typeof type === 'string' && type ? { type } : {}),
    length,
    parsed,
  };
}

/**
 * A log line about an upstream's error body that does not contain it.
 *
 * `/privacy` §5 promises prompt text is never written to a log, and a 4xx body
 * is where a model server quotes the request back — vLLM names the offending
 * field and some gateways echo its value with it. The caller still receives the
 * upstream's own wording on the wire, which is what SUP-448 was for; the log
 * does not need it to be useful. What is left is enough to triage with: the
 * error class, the field it named, and whether there was a body at all.
 *
 * `type` and `param` are the upstream's own vocabulary for *its* API, not
 * anything the caller typed — `invalid_request_error`, `messages[2].content` —
 * which is why they stay. Both are checked against {@link LOGGABLE_LABEL} first
 * rather than trusted to be what they are named: an upstream free to write
 * anything into a JSON field is free to write a prompt fragment into this one,
 * and a field *path* never has a space, a quote or a newline in it.
 */
export function describeUpstreamError(body: UpstreamErrorBody): string {
  if (body.length === 0) {
    return 'no body';
  }
  const parts = [
    ...(label(body.type) ? [`type=${body.type}`] : []),
    ...(label(body.param) ? [`param=${body.param}`] : []),
    `${body.length} chars`,
    ...(body.structured ? [] : ['unstructured']),
  ];
  return `${parts.join(', ')} (not logged)`;
}

/**
 * What an OpenAI error class or a request field path looks like, and what prose
 * does not: identifier characters, dots, dashes and array subscripts, and short.
 */
const LOGGABLE_LABEL = /^[\w.[\]-]{1,120}$/;

function label(value: string | undefined): boolean {
  return value !== undefined && LOGGABLE_LABEL.test(value);
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
    // `body.text`, structured or not — see `CONTEXT_LENGTH`, which is where the
    // reason this row forwards what the others withhold is written down.
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
