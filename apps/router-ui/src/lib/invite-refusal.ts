/**
 * What the console says when an invite-only deployment refuses a sign-up
 * (SUP-173).
 *
 * Three codes, one sentence each, and they have to read differently enough that
 * nobody skims past the wrong one: "your link has already been used" and "you
 * need a link" send a person to two different places, and the reason this
 * exists is that the old single message was missed by the person who hit it.
 *
 * The same three arrive by two routes, because the three sign-up paths answer in
 * two different ways:
 *
 *  - **a mailed code** — the console's own request, so a 403 whose body carries
 *    the code, read off `AuthRequestError.code`;
 *  - **magic link and OAuth** — a navigation, so the refusal comes back as
 *    `?error=<code>` on the page the visitor started from.
 *
 * Mirrored from `apps/router-api/src/app/invites/invite-requirement.ts` rather
 * than imported: the console must not depend on the API's source tree, and what
 * the two share is three string constants, not a module.
 */

export type InviteRefusalCode = 'invite_required' | 'invite_already_claimed' | 'invite_expired_or_unknown';

const CODES: readonly string[] = [
  'invite_required',
  'invite_already_claimed',
  'invite_expired_or_unknown',
] satisfies readonly InviteRefusalCode[];

export function isInviteRefusalCode(value: string | null | undefined): value is InviteRefusalCode {
  return value !== null && value !== undefined && CODES.includes(value);
}

/**
 * The console's own copy, not the router's.
 *
 * The router's message has to make sense to `curl`; this one is read on a screen
 * that already shows the code input underneath it, so it can end with what to do
 * next instead of restating where the visitor is.
 */
export const INVITE_REFUSAL_COPY: Record<InviteRefusalCode, { title: string; detail: string }> = {
  invite_required: {
    title: 'You need an invitation to create an account here.',
    detail: 'Open the link you were sent, or paste its code below. Signing in to an existing account still works.',
  },
  invite_already_claimed: {
    title: 'This invitation has already been claimed.',
    detail: 'An account was created with it. Sign in with that account, or ask for a new invitation.',
  },
  invite_expired_or_unknown: {
    title: 'This invitation cannot be used.',
    detail: 'It may have expired, or the code may be mistyped. Check the link you were sent, or ask for a new one.',
  },
};

/**
 * The refusal this page load is carrying, from `?error=`.
 *
 * Only the three codes above are recognised. Better Auth puts its own errors
 * through the same parameter — `INVALID_TOKEN`, `state_not_found` — and those
 * are not about invitations, so they are left to the screen's ordinary error
 * handling rather than mistranslated into one of these sentences.
 */
export function inviteRefusalOf(search: string): InviteRefusalCode | null {
  const error = new URLSearchParams(search).get('error');
  return isInviteRefusalCode(error) ? error : null;
}
