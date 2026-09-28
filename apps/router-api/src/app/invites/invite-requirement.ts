/**
 * What a deployment says when it refuses a sign-up for want of an invitation
 * (SUP-173).
 *
 * Three codes, no more. They are a contract with the console — it renders one
 * sentence per code — and they are the only thing an anonymous caller learns
 * about an invitation they do not hold, so the set is chosen for what it is safe
 * to say rather than for what the service knows:
 *
 *  - `invite_required` — the request carried no code at all. Says nothing about
 *    any code.
 *  - `invite_already_claimed` — the code exists and its seats are gone. This is
 *    the one refusal a visitor can act on without asking anybody: it means the
 *    link was used, not mistyped. It does confirm that the code was real, which
 *    is why it is the *only* outcome that does — and a spent code is worth
 *    nothing to whoever confirmed it.
 *  - `invite_expired_or_unknown` — everything else: never issued, expired, or
 *    withdrawn by an operator. Deliberately one code, so the endpoint cannot be
 *    used to tell a real code from a guess, and so a withdrawn code (SUP-159)
 *    does not announce that it was withdrawn.
 *
 * The public lookup `GET /v1/invites/:code` is unchanged and still collapses
 * every unusable code into one `unavailable` — it answers about a code nobody
 * has committed to, where even `already_claimed` is more than it needs to say.
 *
 * That split is load-bearing in one direction: because the lookup says less than
 * this does, these three are the *only* place a browser can learn that a link was
 * spent rather than mistyped, so the console submits a code its pre-check called
 * `unavailable` instead of holding the button (SUP-176). Nothing here has to
 * change for that — the refusal already precedes the insert — but it is why
 * widening the lookup would be the wrong fix and why this set must stay typed.
 */

import type { InviteUnusableReason } from './invites.service.js';

/** The closed set the console renders. Adding a fourth is a contract change. */
export type SignUpRefusalCode = 'invite_required' | 'invite_already_claimed' | 'invite_expired_or_unknown';

/** Why the pre-check turned a sign-up away. `missing` is "no code on the request". */
export type SignUpRefusalReason = 'missing' | InviteUnusableReason;

export function signUpRefusalCodeOf(reason: SignUpRefusalReason): SignUpRefusalCode {
  if (reason === 'missing') {
    return 'invite_required';
  }
  return reason === 'exhausted' ? 'invite_already_claimed' : 'invite_expired_or_unknown';
}

/**
 * The sentence that travels with the code.
 *
 * The console has its own copy for each code and normally shows that; this is
 * what a client which does not — `curl`, an SDK, the OAuth error page of a
 * console that predates this — has to be able to read on its own.
 */
export const SIGN_UP_REFUSAL_MESSAGES: Record<SignUpRefusalCode, string> = {
  invite_required: 'Registration on this deployment is by invitation. Sign up with the link you were sent.',
  invite_already_claimed: 'This invitation has already been claimed. Ask for a new one.',
  invite_expired_or_unknown: 'This invitation cannot be used. Check the link you were sent, or ask for a new one.',
};
