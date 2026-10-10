import { publishInviteCookie, withInvite } from './invite';
import { publicConfig } from './public-config';
import { clearSignedIn, markSignedIn } from './signed-in-cookie';

export type SocialProvider = 'github' | 'google';

export class AuthRequestError extends Error {
  /** HTTP status of the failed response, when there was one to read. */
  readonly status?: number;
  /**
   * Better Auth's machine-readable `code`, when the body carried one.
   *
   * The refusals this console has copy for — `invite_required` and the other two
   * of SUP-173 — are told apart by this and not by the status: an invite-only
   * deployment answers 403 to all three.
   */
  readonly code?: string;

  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.name = 'AuthRequestError';
    this.status = status;
    this.code = code;
  }
}

async function postToAuth(path: string, body: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${publicConfig().apiOrigin}/auth${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // The session cookie is set on the API origin, so it has to be sent and
      // stored cross-origin.
      credentials: 'include',
      body: JSON.stringify(body),
    });
  } catch {
    throw new AuthRequestError('Could not reach the API. Check that router-api is running.');
  }

  if (!response.ok) {
    // Better Auth returns `{ message, code }` on failure. Anything else (a proxy
    // error page, say) must not be shown to the viewer verbatim.
    const body = await response
      .json()
      .then((parsed: { message?: unknown; code?: unknown }) => parsed)
      .catch(() => null);
    const detail = typeof body?.message === 'string' ? body.message : null;
    const code = typeof body?.code === 'string' ? body.code : undefined;
    throw new AuthRequestError(detail ?? 'Sign-in failed. Please try again.', response.status, code);
  }

  return response.json().catch(() => ({}));
}

/**
 * Starts an OAuth sign-in. Better Auth answers with the provider's authorize
 * URL rather than a redirect, so the caller navigates.
 *
 * An invitation code cannot ride this one: the account is created by the
 * provider's callback, a URL the provider built, where nothing of ours survives
 * except a cookie on the API's origin. So the code is published as `cr_invite`
 * before the browser leaves — see `publishInviteCookie` for why that is the only
 * hop that needs one.
 */
export async function signInWithProvider(provider: SocialProvider, inviteCode?: string | null): Promise<void> {
  if (inviteCode) {
    publishInviteCookie(inviteCode);
  }
  const result = (await postToAuth('/sign-in/social', {
    provider,
    callbackURL: withInvite(publicConfig().authCallbackUrl, inviteCode ?? null),
    errorCallbackURL: thisPageUrl(),
  })) as { url?: unknown };

  if (typeof result.url !== 'string') {
    throw new AuthRequestError(`${provider} sign-in is not configured on this deployment.`);
  }

  window.location.assign(result.url);
}

/**
 * Mails a magic link. Resolves once the mail is accepted — never with a session.
 *
 * `callbackURL` is the only thing that survives from here to the verification
 * request that creates the account, so an invitation code travels in it.
 */
export async function signInWithMagicLink(email: string, inviteCode?: string | null): Promise<void> {
  await postToAuth('/sign-in/magic-link', {
    email,
    callbackURL: withInvite(publicConfig().authCallbackUrl, inviteCode ?? null),
    errorCallbackURL: thisPageUrl(),
  });
}

/**
 * Asks the router to mail a one-time sign-in code (SUP-269).
 *
 * Resolves the same way whether or not the address has an account — the router
 * answers identically either way, so the console can only ever say "a code is
 * on its way", never "this address is registered". Only reachable while
 * `signInOptions.emailCode` is true: a deployment with no mailer does not
 * register the route at all and answers 404.
 *
 * Nothing about an invitation rides this request. The code is asked for by
 * address alone, and the account — if there is to be one — is created by the
 * request that hands the code back.
 */
export async function requestSignInCode(email: string): Promise<void> {
  await postToAuth('/email-otp/send-verification-otp', { email, type: 'sign-in' });
}

/**
 * Trades a mailed code for a session — and, for an address with no account,
 * creates the account first. This one request is both sign-in and sign-up.
 *
 * `name` and `inviteCode` mean something only in the second case, and the
 * router ignores them in the first: an existing account is neither renamed nor
 * topped up by signing in (SUP-142). Both are left out of the body rather than
 * sent empty, so a sign-in from the screen that has neither is exactly the
 * request Better Auth documents.
 *
 * The router calls the code `otp`; the console calls it what the mail does.
 *
 * A code is spent by being checked, whatever the answer. That is why the
 * screens validate an invitation *before* asking for a code: a sign-up an
 * invite-only deployment refuses has still used the code up.
 */
export async function signInWithCode(input: {
  email: string;
  code: string;
  name?: string;
  inviteCode?: string | null;
}): Promise<void> {
  const name = input.name?.trim();
  await postToAuth('/sign-in/email-otp', {
    email: input.email,
    otp: input.code,
    ...(name ? { name } : {}),
    ...(input.inviteCode ? { inviteCode: input.inviteCode } : {}),
  });
}

/**
 * This page, absolute, for the router to send a refused sign-up back to.
 *
 * The two paths that create an account by navigation — a magic-link
 * verification and an OAuth callback — cannot answer a browser with JSON, so a
 * refusal arrives as `?error=<code>` on a URL the router redirects to
 * (SUP-173). It has to be absolute: the router resolves a relative one against
 * its **own** origin, which is the API's and not this console's.
 *
 * The page the visitor started from, rather than a fixed screen, because the
 * way out of `invite_required` is the button they just pressed — the provider
 * is on `/login`, the form is on `/signup`, and neither page has the other's.
 * The query is dropped: the router appends its own, and a stale `?invite=` there
 * would outlive the code it named.
 */
function thisPageUrl(): string {
  const { origin, pathname } = globalThis.location ?? { origin: '', pathname: '/' };
  return `${origin}${pathname}`;
}

/**
 * Trades the deployment's bootstrap token for a session on the administrator's
 * account — creating that account if the deployment has none yet.
 *
 * Reachable in two states, and the router says which: `signInOptions.bootstrap`
 * while no user exists, when the token creates the first account, and
 * `signInOptions.adminRecovery` once that account exists, when the same token
 * signs it back in — the administrator's way in on a deployment that cannot
 * mail a code. The endpoint is registered at all only when a token is
 * configured. Nothing is returned — the session arrives as a cookie, exactly as
 * it does from a mailed code.
 */
export async function signInWithBootstrapToken(token: string): Promise<void> {
  await postToAuth('/bootstrap', { token });
}

export async function signOut(): Promise<void> {
  try {
    await postToAuth('/sign-out', {});
  } finally {
    // Whatever the API answered, this browser is done: a marker left standing
    // would bounce the viewer straight back into the console they asked to
    // leave, and the API is the one that decides whether the session survived.
    clearSignedIn();
  }
}

/**
 * Where to send the browser once a sign-in has succeeded.
 *
 * `proxy.ts` puts the path it denied in `?next=`, so a deep link survives the
 * round trip through the sign-in screen. Only a path on this origin is honoured:
 * `?next=https://evil.example` — or `//evil.example`, which a browser reads as
 * an origin too — would otherwise make the console an open redirector.
 */
export function signInDestination(search: string = globalThis.location?.search ?? '', fallback?: string): string {
  const next = new URLSearchParams(search).get('next');
  const local = next?.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\');

  return local ? (next as string) : (fallback ?? publicConfig().authCallbackUrl);
}

/**
 * Finishes a sign-in the console itself performed: raise the console-host marker
 * `proxy.ts` routes on, then leave for the destination.
 *
 * A full navigation rather than a router push, because the session cookie was
 * just set on the API origin and every cached Apollo result on this page was
 * fetched without one.
 */
export function completeSignIn(fallback?: string): void {
  markSignedIn();
  window.location.assign(signInDestination(globalThis.location?.search ?? '', fallback));
}
