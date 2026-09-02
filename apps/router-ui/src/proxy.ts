import { type NextRequest, NextResponse } from 'next/server';
import { isPublicPath } from './lib/public-paths';
import { SIGNED_IN_COOKIE_NAME } from './lib/signed-in-cookie';

/**
 * Keeps a signed-out browser off the console and a signed-in one off the sign-in
 * screen. (`proxy.ts` is Next 16's name for what used to be `middleware.ts`.)
 *
 * What it reads is the console's own marker cookie, never router-api's session
 * cookie: that one is HttpOnly and lives on the API's hostname, which this
 * middleware runs nowhere near (`lib/signed-in-cookie.ts` has the whole story).
 *
 * This is a routing convenience, **not** an authorisation boundary. The marker
 * is a browser's own claim about itself; every piece of data still comes from a
 * GraphQL call that the API authorises on its own, and an unauthenticated answer
 * to any of them clears the marker again.
 */
export default function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const signedIn = request.cookies.has(SIGNED_IN_COOKIE_NAME);
  const isPublic = isPublicPath(pathname);

  if (!signedIn && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = '';
    // Where to come back to after the round trip through the provider or inbox.
    if (pathname !== '/') url.searchParams.set('next', `${pathname}${search}`);
    return NextResponse.redirect(url);
  }

  if (signedIn && isPublic) {
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
