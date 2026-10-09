/**
 * The console paths a browser with no session may reach.
 *
 * Shared, because two layers have to agree on the same list: `proxy.ts`, which
 * bounces everything else to `/login`, and the Apollo error handler, which must
 * *not* bounce a viewer who is already standing on one of them.
 */
export const PUBLIC_PATHS = ['/login', '/signup', '/forgot-password', '/reset-password'];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

/**
 * Public paths a signed-in browser may reach as well (SUP-269).
 *
 * A password reset link can be opened from any browser, including one that is
 * signed in — to this account or another — and bouncing it to the console would
 * throw the token away. The reset revokes every session of the account it
 * belongs to anyway.
 */
export const OPEN_PATHS = ['/reset-password'];

export function isOpenPath(pathname: string): boolean {
  return OPEN_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}
