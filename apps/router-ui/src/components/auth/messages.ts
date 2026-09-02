import { AuthRequestError } from '../../lib/auth';

/**
 * What to show the viewer when an auth request failed.
 *
 * Only errors this app raised are rendered at all: anything else could be a
 * network stack detail with an internal hostname in it. Better Auth's own
 * `message` is shown as-is unless the caller has something better to say about
 * a particular status — a 404 from a path this deployment did not enable means
 * something quite different from "not found".
 */
export function messageOf(error: unknown, byStatus: Record<number, string> = {}): string {
  if (!(error instanceof AuthRequestError)) {
    return 'Sign-in failed. Please try again.';
  }
  const known = error.status === undefined ? undefined : byStatus[error.status];
  return known ?? error.message;
}
