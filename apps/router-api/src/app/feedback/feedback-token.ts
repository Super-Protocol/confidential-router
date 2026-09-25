import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The short-lived token the console puts in the form's hidden fields.
 *
 * The form is public — anyone with the link can open it — so whatever it carries
 * back is what decides which account gets credited. A raw user id would
 * therefore be a way to mint $100 into a stranger's account by typing their
 * UUID into a public form. This token is a signed statement instead: *this
 * deployment says this user asked for the form, at this moment*.
 *
 * Minutes, not days. The token's only job is to survive the walk from the
 * console to the submit button; a long-lived one that leaked in a browser
 * history or a shared screenshot would be a grant waiting to be claimed.
 *
 * The key is derived from `auth.secret` rather than configured separately:
 * one secret to deploy and rotate, and the derivation keeps this HMAC from
 * sharing a key with session cookies or `saltedHash`.
 */

const VERSION = 'v1';
const KEY_INFO = 'feedback-form-token';

export interface FeedbackTokenClaims {
  userId: string;
  workspaceId: string;
  /** Epoch milliseconds at which the console minted the token. */
  issuedAt: number;
}

export type FeedbackTokenFailure = 'malformed' | 'bad_signature' | 'expired';

export type FeedbackTokenVerification =
  | { valid: true; claims: FeedbackTokenClaims }
  | { valid: false; failure: FeedbackTokenFailure };

/** Domain-separated signing key, so this HMAC cannot be confused with another. */
function keyOf(secret: string): Buffer {
  return createHmac('sha256', secret).update(KEY_INFO).digest();
}

function payloadOf(claims: FeedbackTokenClaims): string {
  return [VERSION, claims.userId, claims.workspaceId, String(claims.issuedAt)].join(':');
}

function sign(secret: string, payload: string): string {
  return createHmac('sha256', keyOf(secret)).update(payload).digest('base64url');
}

/**
 * `<payload>.<signature>`, both base64url.
 *
 * The payload is encoded rather than sent as-is so that a colon in an id — there
 * is none today, and there is no reason to depend on that — cannot move the
 * boundary between two claims and let one field's value be read as another's.
 */
export function issueFeedbackToken(secret: string, claims: FeedbackTokenClaims): string {
  const payload = payloadOf(claims);
  return `${Buffer.from(payload, 'utf8').toString('base64url')}.${sign(secret, payload)}`;
}

export function verifyFeedbackToken(
  secret: string,
  token: string,
  options: { ttlMs: number; now?: Date },
): FeedbackTokenVerification {
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { valid: false, failure: 'malformed' };
  }

  const payload = Buffer.from(parts[0], 'base64url').toString('utf8');
  // Signature first: nothing about the payload is trusted, including its shape,
  // until the deployment's own key says it wrote it.
  if (!equals(sign(secret, payload), parts[1])) {
    return { valid: false, failure: 'bad_signature' };
  }

  const [version, userId, workspaceId, issuedAtText] = payload.split(':');
  const issuedAt = Number(issuedAtText);
  if (version !== VERSION || !userId || !workspaceId || !Number.isSafeInteger(issuedAt)) {
    return { valid: false, failure: 'malformed' };
  }

  const now = (options.now ?? new Date()).getTime();
  // A token from the future is as wrong as an expired one: it means a clock has
  // moved, and the window it would buy is not one this deployment granted.
  if (issuedAt > now || now - issuedAt > options.ttlMs) {
    return { valid: false, failure: 'expired' };
  }

  return { valid: true, claims: { userId, workspaceId, issuedAt } };
}

/** Constant-time comparison that does not leak the length either. */
function equals(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(actual, 'utf8');
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}
