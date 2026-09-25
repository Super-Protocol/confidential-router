import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FeedbackAnswers } from '../db/entities/feedback-submission.entity.js';

/**
 * Everything specific to Typeform: the delivery signature and the shape of a
 * `form_response` payload.
 *
 * Pure functions over bytes, deliberately. The form provider is the one part of
 * this feature chosen for price rather than for architecture — if Typeform's
 * tier stops fitting, Tally signs its webhooks the same way (HMAC-SHA256 over
 * the raw body, base64, in a header) and carries the same hidden fields, so the
 * replacement is a second file beside this one and `FeedbackService` does not
 * change. Keeping the provider's vocabulary out of the service is what makes
 * that true.
 */

/** The header Typeform signs each delivery with. */
export const TYPEFORM_SIGNATURE_HEADER = 'typeform-signature';

/** The hidden field carrying our own short-lived token. Short: it rides in a URL. */
export const FEEDBACK_TOKEN_FIELD = 't';

const SIGNATURE_PREFIX = 'sha256=';

/** One submission, in vocabulary the rest of the feature shares with any provider. */
export interface FeedbackDelivery {
  /** The provider's response id. Stable across redeliveries of the same submission. */
  submissionId: string;
  formId: string | null;
  /** Our signed token, from the form's hidden fields. */
  token: string | null;
  submittedAt: Date;
  /**
   * What to keep for analysis: the answers and the question definitions they
   * refer to, and **never** the hidden fields — those carry a credential, and a
   * credential in an analytics table is a credential in every backup of it.
   */
  answers: FeedbackAnswers;
}

/**
 * Whether Typeform signed these exact bytes.
 *
 * Over the raw body, which is why `bootstrap.ts` mounts `express.raw` on this
 * path: a body that has been parsed and reserialised is a different byte string,
 * and would fail a signature that was never wrong.
 */
export function verifyTypeformSignature(secret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!header?.startsWith(SIGNATURE_PREFIX)) {
    return false;
  }
  const provided = Buffer.from(header.slice(SIGNATURE_PREFIX.length), 'base64');
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  if (provided.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(provided, expected);
}

/**
 * Reads a delivery, or `null` when it is not a form submission at all.
 *
 * Returning `null` rather than throwing for an unrecognised `event_type` is the
 * same rule the payment webhook follows: an event we will never handle has to
 * get a 200, because the alternative is the provider retrying it for days.
 */
export function parseTypeformDelivery(rawBody: Buffer): FeedbackDelivery | null {
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return null;
  }
  if (!isRecord(payload)) {
    return null;
  }

  const response = payload.form_response;
  if (payload.event_type !== 'form_response' || !isRecord(response)) {
    return null;
  }

  const submissionId = typeof response.token === 'string' ? response.token : null;
  if (!submissionId) {
    return null;
  }

  const hidden = isRecord(response.hidden) ? response.hidden : {};
  const definition = isRecord(response.definition) ? response.definition : {};
  const submittedAt = typeof response.submitted_at === 'string' ? new Date(response.submitted_at) : new Date();

  return {
    submissionId,
    formId: typeof response.form_id === 'string' ? response.form_id : null,
    token: typeof hidden[FEEDBACK_TOKEN_FIELD] === 'string' ? (hidden[FEEDBACK_TOKEN_FIELD] as string) : null,
    submittedAt: Number.isNaN(submittedAt.getTime()) ? new Date() : submittedAt,
    answers: {
      answers: Array.isArray(response.answers) ? response.answers : [],
      fields: Array.isArray(definition.fields) ? definition.fields : [],
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
