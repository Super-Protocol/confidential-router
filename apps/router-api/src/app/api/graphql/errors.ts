import { HttpException } from '@nestjs/common';
import type { GraphQLFormattedError } from 'graphql';

/**
 * The stable error codes this schema answers with.
 *
 * A GraphQL response is `200 OK` whatever happened, so `extensions.code` is the
 * only thing a client can branch on — the console already keys its
 * sign-in redirect off `UNAUTHENTICATED`. Resolvers keep throwing ordinary Nest
 * exceptions; this is the one place their HTTP status becomes a code, so the
 * mapping cannot differ between two resolvers that both mean "not yours".
 */
export const CONSOLE_ERROR_CODES = {
  400: 'BAD_USER_INPUT',
  401: 'UNAUTHENTICATED',
  402: 'PAYMENT_REQUIRED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  422: 'BAD_USER_INPUT',
  429: 'TOO_MANY_REQUESTS',
} as const;

export const INTERNAL_ERROR_CODE = 'INTERNAL_SERVER_ERROR';

/** What a client is told when the fault is ours and internals are not exposed. */
export const INTERNAL_ERROR_MESSAGE = 'Internal server error.';

/**
 * Codes Apollo itself assigns before a resolver ever runs — a malformed
 * document, an unknown field, a variable of the wrong type. They are already
 * stable and already describe the client's mistake, so they are kept as they
 * are rather than flattened into one of ours.
 */
const APOLLO_CODES = new Set([
  'BAD_REQUEST',
  'BAD_USER_INPUT',
  'GRAPHQL_PARSE_FAILED',
  'GRAPHQL_VALIDATION_FAILED',
  'OPERATION_RESOLUTION_FAILURE',
  'PERSISTED_QUERY_NOT_FOUND',
  'PERSISTED_QUERY_NOT_SUPPORTED',
]);

/** The HTTP status a Nest exception carries, wherever Apollo wrapped it. */
function statusOf(error: unknown, depth = 0): number | null {
  if (error instanceof HttpException) {
    return error.getStatus();
  }
  // `originalError` may nest twice: Apollo wraps the resolver's throw, and a
  // Nest exception filter may itself have wrapped something.
  const nested = (error as { originalError?: unknown })?.originalError;
  return nested && depth < 4 ? statusOf(nested, depth + 1) : null;
}

/**
 * Turns a thrown exception into a formatted error with a stable code.
 *
 * @param exposeInternals mirrors `graphql.introspection` — a deployment that
 *   does not narrate its schema must not narrate its stack traces either. With
 *   it off, an unmapped error becomes a bare `INTERNAL_SERVER_ERROR` and the
 *   original message is dropped, because a driver or ORM message is exactly the
 *   kind of thing that leaks a table name or a connection string.
 */
export function formatConsoleError(
  formatted: GraphQLFormattedError,
  raw: unknown,
  exposeInternals: boolean,
): GraphQLFormattedError {
  const existing = formatted.extensions?.code;
  const status = statusOf(raw);
  const code =
    typeof existing === 'string' && APOLLO_CODES.has(existing)
      ? existing
      : status === null
        ? INTERNAL_ERROR_CODE
        : (CONSOLE_ERROR_CODES[status as keyof typeof CONSOLE_ERROR_CODES] ??
          (status < 500 ? 'BAD_REQUEST' : INTERNAL_ERROR_CODE));

  const internal = code === INTERNAL_ERROR_CODE;
  const extensions: Record<string, unknown> = { ...formatted.extensions, code };
  if (status !== null) {
    extensions.status = status;
  }
  if (!exposeInternals) {
    // Apollo puts the whole Nest exception, and the stack, in here.
    delete extensions.originalError;
    delete extensions.stacktrace;
    delete extensions.exception;
  }

  return {
    ...formatted,
    message: internal && !exposeInternals ? INTERNAL_ERROR_MESSAGE : formatted.message,
    extensions,
  };
}
