/**
 * Browser-visible configuration.
 *
 * `NEXT_PUBLIC_*` is inlined at build time, so these must be literal property
 * reads — `process.env[name]` does not get substituted.
 */

/** router-api's GraphQL endpoint. */
export const GRAPHQL_HTTP_URL = process.env.NEXT_PUBLIC_GRAPHQL_HTTP ?? 'http://127.0.0.1:3000/graphql';

/** router-api's origin. Better Auth is mounted under `<origin>/auth` (ADR-004). */
export const API_ORIGIN = process.env.NEXT_PUBLIC_API_ORIGIN ?? 'http://127.0.0.1:3000';

/** Where Better Auth sends the browser back after a social or magic-link sign-in. */
export const AUTH_CALLBACK_URL = process.env.NEXT_PUBLIC_AUTH_CALLBACK_URL ?? '/';

/**
 * Name of the session cookie router-api sets (`SESSION_COOKIE_NAME`, ADR-004 §4).
 * The middleware only checks that it is *present*: the cookie is HttpOnly and
 * opaque, so the UI cannot and must not try to validate it. The API is the only
 * thing that decides whether a session is real.
 */
export const SESSION_COOKIE_NAME = 'cr_session';
