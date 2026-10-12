import { CombinedGraphQLErrors, ServerError } from '@apollo/client';
import type { GraphQLFormattedError } from 'graphql';

/**
 * The GraphQL error behind a failed request, wherever the transport left it.
 *
 * Two places, and the second one is why SUP-295 item 2 looked like a mystery. A
 * GraphQL response with `errors` arrives as `CombinedGraphQLErrors`. A response
 * the server refused *before* executing it — a malformed document, a variable of
 * the wrong type, a body the proxy in front of us rejected — arrives with a
 * non-200 status, and Apollo's HTTP link throws `ServerError` on the status code
 * without parsing the body at all. Reading only the first of those turned every
 * instance of the second into one opaque sentence with nothing to act on.
 */
function firstErrorOf(error: unknown): GraphQLFormattedError | null {
  if (CombinedGraphQLErrors.is(error)) {
    return error.errors[0] ?? null;
  }
  if (ServerError.is(error)) {
    try {
      const body = JSON.parse(error.bodyText) as { errors?: GraphQLFormattedError[] };
      return body.errors?.[0] ?? null;
    } catch {
      // A proxy's HTML error page, or an empty body. The status is all there is.
      return null;
    }
  }
  return null;
}

/**
 * What to put in front of the user when a mutation fails.
 *
 * A GraphQL error message is written for a user — `BAD_USER_INPUT` carries the
 * validation text — and is shown as it is. Anything else is a transport failure
 * whose message can name internal hosts, so it is replaced; the status code is
 * kept, because "the server answered 502" is the difference between a bug report
 * someone can act on and "it failed".
 *
 * The one soft edge: a non-200 body that parses as a GraphQL response is taken
 * at its word, and a proxy between us and the API could in principle return one.
 * It would have to serve a JSON body with an `errors` array to do any harm, and
 * the realistic case — an HTML error page — falls through to the status.
 */
export function errorMessageOf(error: unknown, fallback = 'The request failed. Please try again.'): string {
  const first = firstErrorOf(error);
  if (first?.message) {
    return first.message;
  }
  if (ServerError.is(error)) {
    return `${fallback} (The server answered ${error.statusCode}.)`;
  }
  return fallback;
}

/**
 * The fields the API refused, keyed by the input property it named.
 *
 * Filled by `formatConsoleError` from the validation pipe's own per-field
 * messages, so a form can show each one under the input it is about instead of
 * one sentence under the whole dialog (`apps/router-api`, `validation-error.ts`).
 * Empty whenever the failure was not about a particular field.
 */
export function fieldErrorsOf(error: unknown): Record<string, string> {
  const fields = firstErrorOf(error)?.extensions?.fields;
  if (typeof fields !== 'object' || fields === null) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(fields as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}
