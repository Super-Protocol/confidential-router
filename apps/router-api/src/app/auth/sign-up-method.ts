/**
 * Which of ADR-004's sign-in paths created an account.
 *
 * The `method` property of `signup_completed` (`docs/contracts/analytics-events.md`),
 * and the one thing about a new account that is only knowable from the request
 * Better Auth was handling when it inserted the row — by the time the hook runs,
 * the `account` row naming the provider has not been written yet.
 */

/** The taxonomy's closed set. No fifth value: adding one is a change to the contract. */
export type SignUpMethod = 'password' | 'magic_link' | 'github' | 'google';

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
  return 'password';
}
