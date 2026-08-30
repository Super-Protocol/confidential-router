import { type NextRequest, NextResponse } from 'next/server';
import { SESSION_COOKIE_NAME } from './lib/env';

/**
 * Keeps a signed-out browser off the console and a signed-in one off the sign-in
 * screen. (`proxy.ts` is Next 16's name for what used to be `middleware.ts`.)
 *
 * This is a routing convenience, **not** an authorisation boundary: the cookie
 * is opaque and only router-api can say whether it names a live session. Every
 * piece of data still comes from a GraphQL call that the API authorises on its
 * own. Presence of the cookie is all that is checked here.
 */
const PUBLIC_PATHS = ['/login'];

export default function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const hasSession = request.cookies.has(SESSION_COOKIE_NAME);
  const isPublic = PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));

  if (!hasSession && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = '';
    // Where to come back to after the round trip through the provider or inbox.
    if (pathname !== '/') url.searchParams.set('next', `${pathname}${search}`);
    return NextResponse.redirect(url);
  }

  if (hasSession && isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = '/';
    url.search = '';
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  /*
   * Everything except Next's own assets, the favicon, and `/dev` — the component
   * gallery renders primitives with no data and must stay reachable while
   * signed out.
   */
  matcher: ['/((?!_next/static|_next/image|favicon.ico|dev|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)'],
};
