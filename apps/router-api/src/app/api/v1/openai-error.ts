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

  rateLimited: (message: string, headers: Record<string, string>) =>
    new OpenAiApiError({ status: 429, type: 'rate_limit_error', code: 'rate_limit_exceeded', message, headers }),

  backendUnavailable: (message: string) =>
    new OpenAiApiError({ status: 502, type: 'upstream_error', code: 'backend_unavailable', message }),

  backendError: (message: string) =>
    new OpenAiApiError({ status: 502, type: 'upstream_error', code: 'backend_error', message }),

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
