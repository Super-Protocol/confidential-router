/**
 * The console paths a browser with no session may reach.
 *
 * Shared, because two layers have to agree on the same list: `proxy.ts`, which
 * bounces everything else to `/login`, and the Apollo error handler, which must
 * *not* bounce a viewer who is already standing on one of them.
 */
export const PUBLIC_PATHS = ['/login', '/signup'];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}
