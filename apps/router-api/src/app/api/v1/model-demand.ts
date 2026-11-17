import { OpenAiApiError } from './openai-error.js';

/**
 * What `/v1` can say about the model a request asked for — SUP-542.
 *
 * Pure, and separate from the gateway, for the reason `client-dimension.ts` is:
 * the interesting part is the rule about what may leave the deployment, and that
 * rule should be readable and testable without a request, a key or an upstream.
 *
 * **One field of the body is read, and it is `model`.** Not the messages, not the
 * prompt, not `system`, not a tool definition — the taxonomy's privacy rule is
 * not a convention here, it is the reason this file has no access to anything
 * else.
 */

/** Longer than any real model id, short enough that a breakdown stays a breakdown. */
const MAX_SLUG_LENGTH = 64;

/**
 * The shape of a model identifier, as the OpenAI ecosystem spells them:
 * `gpt-4o`, `qwen/qwen3-coder-next`, `claude-sonnet-4-5`, `llama3.3:70b`,
 * `openai/gpt-4o-2024-11-20`.
 *
 * It has to start and end on something alphanumeric, which is what stops a
 * trimmed fragment of prose — `the model i want,` — from looking like an id.
 */
const SLUG_SHAPE = /^[a-z0-9](?:[a-z0-9._:/+-]*[a-z0-9])?$/;

/**
 * Everything that did not have an identifier's shape, in one row.
 *
 * Deliberately one row and not the value itself. `model_slug` is the only
 * property in the taxonomy whose value a caller supplies, so the honest way to
 * keep convention 2 ("closed value sets by default") is to bound it rather than
 * to trust it: a caller who writes prose into the field buys this row, not a row
 * of their own, and a thousand of them buy this row a thousand times.
 */
export const UNPARSEABLE_SLUG = 'unparseable';

/**
 * The model a request asked for, as `model_requested` reports it — or null when
 * the request named no model at all.
 *
 * Null rather than a placeholder: a body with no `model` is a client bug, there is
 * no demand in it to record, and an event for it would be a row that says nothing
 * about which models people want.
 */
export function requestedModelSlug(body: Record<string, unknown>): string | null {
  const requested = body.model;
  if (typeof requested !== 'string') {
    return null;
  }
  const trimmed = requested.trim().toLowerCase();
  if (trimmed.length === 0) {
    return null;
  }
  // Capped before the shape check, not after: a 4 kB value that happens to be
  // all lowercase letters is not an identifier, and truncating it to 64
  // characters first would make it look like one.
  return trimmed.length <= MAX_SLUG_LENGTH && SLUG_SHAPE.test(trimmed) ? trimmed : UNPARSEABLE_SLUG;
}

/**
 * What the router decided about the model, as the event's `result`.
 *
 * Read off the error the admission path threw rather than re-derived, so the
 * event and the status code the caller received cannot disagree about why a
 * request was refused — the disagreement that makes a chart stop being evidence.
 */
export type ModelDemandResult = 'served' | 'unknown_model' | 'out_of_key_scope' | 'not_verified' | 'unsupported_route';

/**
 * The error table's codes, mapped onto the five answers.
 *
 * `openai-error.ts` owns the codes; this owns which of them are a statement about
 * the *model*. Anything else — a parse failure, a missing field, `n > 1` — is a
 * statement about the request shape, and the caller of {@link resultOf} does not
 * reach here for those because there is no model to report.
 */
export function resultOf(error: unknown): ModelDemandResult | null {
  if (!(error instanceof OpenAiApiError)) {
    return null;
  }
  switch (error.code) {
    case 'model_not_found':
      return 'unknown_model';
    case 'model_not_in_key_scope':
      return 'out_of_key_scope';
    case 'attestation_failed':
    case 'attestation_revoked':
      return 'not_verified';
    case 'unsupported_parameter':
      // Two different refusals share this code. `param: 'model'` is the route the
      // model does not serve, which is demand; `param: 'n'` is a request shape the
      // router rejects, which says nothing about the model and must not be filed
      // as though it did.
      return error.param === 'model' ? 'unsupported_route' : null;
    default:
      return null;
  }
}
