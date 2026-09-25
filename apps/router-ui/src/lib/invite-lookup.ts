import { publicConfig } from './public-config';

/** What `GET /v1/invites/:code` answers, as the sign-up screen reads it. */
export type InviteLookup =
  | { valid: true; grantMicros: string; campaign: string }
  /** The code cannot be redeemed. The endpoint never says which of the reasons it is. */
  | { valid: false }
  /** The router could not be asked. Not the same as "the code is no good". */
  | { valid: false; unknown: true };

/**
 * Asks the router what a code is worth, before the visitor commits to anything.
 *
 * Unauthenticated, because the caller has no account yet — that is the point.
 * The answer is deliberately one-sided: a usable code comes back with its grant
 * and campaign, and every unusable one comes back as the same `unavailable`, so
 * the sign-up screen can say "$100 will be added" but cannot say *why* a code was
 * refused. The reason arrives after registration, from `inviteGrantStatus`, where
 * the caller is known (SUP-142).
 *
 * A transport failure is distinguished from a refusal. "We could not check your
 * code" and "your code is no good" are different sentences, and showing the second
 * because the API was briefly unreachable would talk a visitor out of signing up.
 */
export async function lookupInvite(code: string, signal?: AbortSignal): Promise<InviteLookup> {
  let response: Response;
  try {
    response = await fetch(`${publicConfig().apiOrigin}/v1/invites/${encodeURIComponent(code)}`, {
      // No credentials: this is a public endpoint and the visitor has no session.
      signal,
    });
  } catch {
    return { valid: false, unknown: true };
  }

  if (!response.ok) {
    // 429 included: a rate-limited lookup has told us nothing about the code.
    return { valid: false, unknown: true };
  }

  const body = (await response.json().catch(() => null)) as {
    valid?: unknown;
    grantMicros?: unknown;
    campaign?: unknown;
  } | null;

  if (body?.valid === true && typeof body.grantMicros === 'string' && typeof body.campaign === 'string') {
    return { valid: true, grantMicros: body.grantMicros, campaign: body.campaign };
  }
  return { valid: false };
}
