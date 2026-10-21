/**
 * The error contract of `/v1`, as `docs/contracts/router-api.md` tables it.
 *
 * Every failure the OpenAI-compatible surface can produce is one of these, so
 * an SDK written against OpenAI sees the shape it expects — `{ error: { message,
 * type, code, param } }` — with the router's own vocabulary in `code`.
 */

export type OpenAiErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'insufficient_credits'
  | 'permission_error'
  | 'rate_limit_error'
  | 'upstream_error'
  /**
   * The router refusing to proxy to an upstream it has not verified.
   *
   * The same `type` the user-side gatekeeper emits, deliberately: for a model in
   * another deployment the router *is* a gatekeeper (ADR-008 §1), and a client
   * that already branches on `gatekeeper_error` should not need a second name for
   * the same refusal. The error table in `docs/contracts/router-api.md` says so.
   */
  | 'gatekeeper_error'
  | 'server_error';

export interface OpenAiErrorBody {
  error: {
    message: string;
    type: OpenAiErrorType;
    code: string;
    param?: string;
  };
}

export interface OpenAiErrorInit {
  status: number;
  type: OpenAiErrorType;
  code: string;
  message: string;
  param?: string;
  /** Sent alongside the body — `Retry-After` and the rate-limit trio. */
  headers?: Record<string, string>;
}

export class OpenAiApiError extends Error {
  readonly status: number;
  readonly type: OpenAiErrorType;
  readonly code: string;
  readonly param?: string;
  readonly headers: Record<string, string>;

  constructor(init: OpenAiErrorInit) {
    super(init.message);
    this.name = 'OpenAiApiError';
    this.status = init.status;
    this.type = init.type;
    this.code = init.code;
    this.param = init.param;
    this.headers = init.headers ?? {};
  }

  toBody(): OpenAiErrorBody {
    return {
      error: { message: this.message, type: this.type, code: this.code, ...(this.param ? { param: this.param } : {}) },
    };
  }
}

export const openAiErrors = {
  invalidJson: () =>
    new OpenAiApiError({
      status: 400,
      type: 'invalid_request_error',
      code: 'invalid_json',
      message: 'Request body is not valid JSON.',
    }),

  missingField: (param: string) =>
    new OpenAiApiError({
      status: 400,
      type: 'invalid_request_error',
      code: 'missing_field',
      message: `Missing required field "${param}".`,
      param,
    }),

  unsupportedParameter: (param: string, message: string) =>
    new OpenAiApiError({ status: 400, type: 'invalid_request_error', code: 'unsupported_parameter', message, param }),

  contextLengthExceeded: (message: string) =>
    new OpenAiApiError({
      status: 400,
      type: 'invalid_request_error',
      code: 'context_length_exceeded',
      message,
      param: 'messages',
    }),

  /**
   * The upstream read the request and called it invalid — so the client hears a
   * 4xx, with the upstream's own wording.
   *
   * SUP-448. This used to be `502 backend_error`, and that one line killed every
   * Continue session in SP-447: a 502 is "transient, retry" to every
   * OpenAI-compatible SDK, the offending message was already in the conversation
   * history, so each retry rebuilt the same invalid request, got the same 502, and
   * the user read a permanent client-side bug as our outage. 15 of 97 agent
   * requests in one afternoon, every one of them unrecoverable.
   *
   * Two things make it fixable from the client side. The status says *fix the
   * request*, not *try again*. And the upstream's message comes with it: it is the
   * only place that names which field is wrong, and the router cannot know — here
   * it was one `tool_calls[].function.arguments` holding truncated JSON. That is a
   * deliberate exception to this surface's rule of not forwarding upstream wording
   * (see {@link backendUnavailable}): a 4xx body is *about the caller's request*,
   * not about how this cluster is put together.
   *
   * Which is also the exception's limit, and why `detail` may be empty: it holds
   * wording the upstream put in an error field, never a raw body. An
   * intermediary's HTML page says nothing about the request, so it is logged and
   * the caller gets the no-reason sentence below (`upstream-failure.ts`,
   * `UpstreamErrorBody.structured`).
   *
   * `status` is the upstream's own unless an SDK would retry it; `upstreamStatus`
   * is always what the upstream actually said, because the two can differ and the
   * client should be able to see both.
   */
  upstreamRejectedRequest: (upstream: {
    who: string;
    status: number;
    upstreamStatus: number;
    detail: string;
    param?: string;
  }) =>
    new OpenAiApiError({
      status: upstream.status,
      type: 'invalid_request_error',
      code: 'upstream_invalid_request',
      message: upstream.detail
        ? `${upstream.who} rejected this request as invalid (${upstream.upstreamStatus}): ${upstream.detail}`
        : `${upstream.who} rejected this request as invalid (${upstream.upstreamStatus}) and gave no reason. ` +
          'Retrying it unchanged will fail the same way.',
      ...(upstream.param ? { param: upstream.param } : {}),
    }),

  invalidApiKey: () =>
    new OpenAiApiError({
      status: 401,
      type: 'authentication_error',
      code: 'invalid_api_key',
      message: 'Incorrect API key provided. Send it as "Authorization: Bearer sk-tee-v1-…".',
    }),

  apiKeyRevoked: () =>
    new OpenAiApiError({
      status: 401,
      type: 'authentication_error',
      code: 'api_key_revoked',
      message: 'This API key has been revoked.',
    }),

  apiKeyExpired: () =>
    new OpenAiApiError({
      status: 401,
      type: 'authentication_error',
      code: 'api_key_expired',
      message: 'This API key has expired.',
    }),

  insufficientCredits: () =>
    new OpenAiApiError({
      status: 402,
      type: 'insufficient_credits',
      code: 'insufficient_credits',
      message: 'The workspace has no credit left. Top up to keep routing requests.',
    }),

  keySpendLimitReached: () =>
    new OpenAiApiError({
      status: 402,
      type: 'insufficient_credits',
      code: 'key_spend_limit_reached',
      message: 'This API key has reached its spend limit.',
    }),

  modelNotInKeyScope: (model: string) =>
    new OpenAiApiError({
      status: 403,
      type: 'permission_error',
      code: 'model_not_in_key_scope',
      message: `This API key is not scoped to model "${model}".`,
      param: 'model',
    }),

  modelNotFound: (model: string) =>
    new OpenAiApiError({
      status: 404,
      type: 'invalid_request_error',
      code: 'model_not_found',
      message: `The model "${model}" does not exist or is not available to this key.`,
      param: 'model',
    }),

  notFound: () =>
    new OpenAiApiError({
      status: 404,
      type: 'invalid_request_error',
      code: 'not_found',
      message: 'Unknown endpoint.',
    }),

  /**
   * The body is over the `/v1` parser's limit, so nothing was parsed.
   *
   * Its own code rather than `invalid_json`: the JSON was fine and the client can
   * act on this one by sending less. The limit is named because the number is a
   * deployment's choice (`server.maxInferenceRequestBytes`) and a client has no
   * other way to learn it — SUP-339, where this arrived as Nest's bare
   * `{"statusCode":413}` and an SDK saw neither the shape nor the reason.
   */
  requestTooLarge: (limitBytes: number | null) =>
    new OpenAiApiError({
      status: 413,
      type: 'invalid_request_error',
      code: 'request_too_large',
      message: limitBytes
        ? `Request body is larger than the ${mebibytes(limitBytes)} this router accepts.`
        : 'Request body is larger than this router accepts.',
    }),

  rateLimited: (message: string, headers: Record<string, string>) =>
    new OpenAiApiError({ status: 429, type: 'rate_limit_error', code: 'rate_limit_exceeded', message, headers }),

  backendUnavailable: (message: string) =>
    new OpenAiApiError({ status: 502, type: 'upstream_error', code: 'backend_unavailable', message }),

  backendError: (message: string) =>
    new OpenAiApiError({ status: 502, type: 'upstream_error', code: 'backend_error', message }),

  /**
   * The router stopped waiting for the upstream; the upstream itself never failed.
   *
   * A separate code from {@link backendUnavailable} because it names a different
   * party. `backend_unavailable` says the backend could not be reached, and SUP-339
   * is what that costs when it is not true: a long prompt and a concurrent burst
   * both answered perfectly on the direct path, and an operator reading
   * "unreachable" went and looked at a model deployment that was fine. 504, not
   * 502: a deadline on a healthy upstream is a gateway timeout, and the request is
   * worth retrying as-is once the queue drains.
   */
  upstreamTimeout: (message: string) =>
    new OpenAiApiError({ status: 504, type: 'upstream_error', code: 'upstream_timeout', message }),

  /**
   * No live verdict admits the upstream this model lives on, so nothing was sent
   * (ADR-008, decision 5). Raised both by the router's own admission check and by
   * the sidecar's fail-closed 503, which is the same refusal one hop further out.
   */
  attestationFailed: (message: string) =>
    new OpenAiApiError({
      status: 503,
      type: 'gatekeeper_error',
      code: 'attestation_failed',
      // `no-store`, like the sidecar's own denial: a cached refusal would outlive
      // the verdict that caused it.
      headers: { 'Cache-Control': 'no-store' },
      message,
    }),

  /**
   * The verdict was withdrawn while a generation was already streaming: the
   * sidecar closed the connection under it (`pkg/proxy/endpoint.go` `applyVerdict`
   * under `failMode: closed`).
   *
   * A separate code from {@link attestationFailed} because it answers a different
   * question — the request was admitted, and then policy changed — and a client
   * that retries a flaky backend should not retry this one until an admin acts.
   * Denis's ruling 5 on SUP-221: the client sees policy, not flakiness.
   */
  attestationRevoked: (message: string) =>
    new OpenAiApiError({
      status: 503,
      type: 'gatekeeper_error',
      code: 'attestation_revoked',
      headers: { 'Cache-Control': 'no-store' },
      message,
    }),

  internal: () =>
    new OpenAiApiError({
      status: 500,
      type: 'server_error',
      code: 'internal',
      message: 'The router failed to handle this request.',
    }),
} as const;

/**
 * Normalises anything thrown inside `/v1` into the contract's shape.
 *
 * The default is a bare 500: an unexpected exception's message is an internal
 * detail, and this surface is reachable with nothing but an API key.
 */
export function asOpenAiError(error: unknown): OpenAiApiError {
  return error instanceof OpenAiApiError ? error : openAiErrors.internal();
}

/** A byte limit as the client is likelier to recognise it: `8 MiB`, `1.5 MiB`. */
function mebibytes(bytes: number): string {
  const value = bytes / 1024 / 1024;
  return `${Number.isInteger(value) ? value : value.toFixed(1)} MiB`;
}
