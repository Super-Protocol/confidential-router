/**
 * Name of the session cookie router-api sets (`SESSION_COOKIE_NAME`, ADR-004 §4).
 * The middleware only checks that it is *present*: the cookie is HttpOnly and
 * opaque, so the UI cannot and must not try to validate it. The API is the only
 * thing that decides whether a session is real.
 */
export const SESSION_COOKIE_NAME = 'cr_session';
