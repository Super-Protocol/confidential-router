import { CombinedGraphQLErrors } from '@apollo/client';

/**
 * What to put in front of the user when a mutation fails.
 *
 * A `CombinedGraphQLErrors` message came from our own API and is written for a
 * user (`BAD_USER_INPUT` carries the validation text). Anything else is a
 * transport failure whose message can name internal hosts, so it is replaced.
 */
export function errorMessageOf(error: unknown, fallback = 'The request failed. Please try again.'): string {
  if (CombinedGraphQLErrors.is(error)) {
    const [first] = error.errors;
    if (first?.message) return first.message;
  }
  return fallback;
}
