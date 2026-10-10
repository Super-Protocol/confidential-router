/**
 * Which of ADR-004's sign-in paths created an account.
 *
 * The `method` property of `signup_completed` (`docs/contracts/analytics-events.md`),
 * and the one thing about a new account that is only knowable from the request
 * Better Auth was handling when it inserted the row — by the time the hook runs,
 * the `account` row naming the provider has not been written yet.
 */

import { BOOTSTRAP_PATH } from './bootstrap-admin.plugin.js';

/**
 * The taxonomy's closed set; adding a value is a change to the contract.
 *
 * `email_code` joined it with SUP-269, which is also when `password` stopped
 * being a sign-up path: it stays in the set for the accounts already reported
 * under it, and as the label the bootstrap fallback below has always used.
 */
export type SignUpMethod = 'password' | 'email_code' | 'magic_link' | 'github' | 'google';

/** The slice of Better Auth's endpoint context this reads. */
export interface SignUpMethodContext {
  /** Better Auth's route, relative to its base path — `/sign-up/email`, `/callback/github`. */
  path?: string;
}

/**
 * What created this account, from the route alone.
 *
 * Matched on a suffix rather than an exact path because the OAuth callback is
 * mounted at more than one prefix across Better Auth versions (`/callback/github`,
 * `/oauth2/callback/github`), and the provider is the part that matters.
 *
 * The fallback is `password`, and it covers exactly one real route:
 * `/bootstrap`, where the deployment's own token creates the first
 * administrator. That account is an operator's, never a campaign sign-up, and
 * calling it `password` is closer to true than inventing a fifth value the
 * taxonomy does not have and the funnels cannot break down on.
 */
/**
 * Whether the deployment's own bootstrap token is creating this account.
 *
 * The one account creation that is not a sign-up: `POST /auth/bootstrap` is the
 * operator claiming a deployment that has no other way in, so the invite-only
 * gate (SUP-173) lets it through. Nobody mailed the operator a code for their
 * own cluster, and a deployment that could not be claimed would be one nobody
 * could ever turn the gate back off on.
 *
 * Matched on the exact path rather than a suffix, unlike the providers below:
 * this one decides whether a check is skipped, so a route that merely ends in
 * `/bootstrap` must not inherit the exemption.
 */
export function isBootstrapSignUp(context: SignUpMethodContext | null | undefined): boolean {
  return context?.path === BOOTSTRAP_PATH;
}

export function signUpMethodOf(context: SignUpMethodContext | null | undefined): SignUpMethod {
  const path = context?.path ?? '';

  if (path.endsWith('/callback/github')) {
    return 'github';
  }
  if (path.endsWith('/callback/google')) {
    return 'google';
  }
  if (path.includes('/magic-link')) {
    return 'magic_link';
  }
  if (path.endsWith('/sign-in/email-otp')) {
    return 'email_code';
  }
  return 'password';
}
