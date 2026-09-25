/**
 * The invitation code, on its way from the mailed URL into the sign-up request.
 *
 * The code travels in the URL and nowhere else (SUP-140): the landing page lives
 * on `router.superprotocol.com` and the console on
 * `console.router.superprotocol.com`, so `localStorage` is not shared between
 * them, and a link forwarded to a colleague arrives in a browser that has never
 * seen either. So the URL is the contract, and everything here exists to keep the
 * code alive across the *console's* own navigations — a reload of `/signup`, a
 * switch to `/login` and back, an OAuth round trip through a provider's domain.
 *
 * Nothing here is a tracking identifier. The code is a bearer token for $100 of
 * credit that the visitor was mailed, it is stored only until the account it pays
 * for exists, and it is cleared the moment the grant is confirmed or refused.
 */

/** The query parameter the invitation URL uses, on both surfaces. */
export const INVITE_QUERY_PARAM = 'invite';

/** Where the console keeps the code between its own page loads. */
export const INVITE_STORAGE_KEY = 'cr_invite';

/**
 * Cookie the console sets before an OAuth redirect.
 *
 * An OAuth callback is a URL the provider built: none of our query parameters
 * survive it, and `localStorage` is not readable from the API origin that handles
 * it. A cookie on the API's own origin is the only thing that does — which is why
 * `sign-up-invite.ts` reads one. It is strictly necessary for the function the
 * visitor asked for and therefore consent-exempt; the landing page sets no cookie
 * at all, which is what keeps its own "no cookies" claim trivially true
 * (SUP-143 review ruling).
 */
export const INVITE_COOKIE_NAME = 'cr_invite';

/** How long the OAuth cookie lives: one round trip, not one session. */
const COOKIE_MAX_AGE_SECONDS = 15 * 60;

/** How the visitor reached the sign-up screen, from the URL alone. */
export type SignUpEntry = 'landing_cta' | 'invite_link' | 'login_switch' | 'direct';

export interface InviteContext {
  /** The code, normalised, or null. */
  code: string | null;
  /** `utm_campaign` as it arrived, lower-cased and trimmed. */
  utmCampaign: string | null;
  entry: SignUpEntry;
}

/**
 * Normalises a code the way router-api stores it: upper case, separators stripped.
 *
 * Mirrored from `apps/router-api/src/app/invites/invite-code.ts` rather than
 * imported, because the console must not depend on the API's source tree. It only
 * has to agree on one property — that the server would treat two spellings as the
 * same code — so that the console can tell "the code you pasted is the one you
 * already redeemed" apart from "a different code".
 */
export function normaliseInviteCode(raw: string): string {
  return raw
    .trim()
    .replace(/[\s-]+/g, '')
    .toUpperCase();
}

/** A non-empty string, normalised, or null. */
function codeOf(raw: string | null | undefined): string | null {
  const code = raw ? normaliseInviteCode(raw) : '';
  return code.length > 0 ? code : null;
}

/**
 * The code this page load carries, URL first and storage second.
 *
 * URL first because it is the only source that can be trusted to be *this*
 * visitor's: a stored code is left over from an earlier visit in the same
 * browser, which is right for a reload and wrong the moment a second person uses
 * the same machine with their own link.
 */
export function readInviteCode(search: string, storage: Storage | null = safeStorage()): string | null {
  return codeOf(new URLSearchParams(search).get(INVITE_QUERY_PARAM)) ?? codeOf(storage?.getItem(INVITE_STORAGE_KEY));
}

/** Everything the sign-up screen needs from the URL it was opened with. */
export function inviteContextOf(search: string, storage: Storage | null = safeStorage()): InviteContext {
  const parameters = new URLSearchParams(search);
  const utmCampaign = parameters.get('utm_campaign')?.trim().toLowerCase();

  return {
    code: readInviteCode(search, storage),
    utmCampaign: utmCampaign || null,
    entry: entryOf(parameters),
  };
}

/**
 * Which of the taxonomy's four entry points this is.
 *
 * `landing_cta` when the URL carries UTM parameters — the mailing's links do, and
 * a visitor who clicked one came through the landing page; `invite_link` when
 * there is a code but no campaign markers, which is an invitation URL opened
 * straight at the console; `login_switch` from the sign-in screen's own link;
 * `direct` otherwise.
 */
function entryOf(parameters: URLSearchParams): SignUpEntry {
  if (parameters.get('utm_source') || parameters.get('utm_campaign')) {
    return 'landing_cta';
  }
  if (parameters.get(INVITE_QUERY_PARAM)) {
    return 'invite_link';
  }
  return parameters.get('from') === 'login' ? 'login_switch' : 'direct';
}

/** Keeps the code across the console's own navigations. Never called with an empty one. */
export function rememberInvite(code: string): void {
  safeStorage()?.setItem(INVITE_STORAGE_KEY, normaliseInviteCode(code));
}

/**
 * Drops the stored code.
 *
 * Called once the grant has been confirmed or explained, so a later visitor to
 * the same browser does not inherit a spent code and a message about it.
 */
export function forgetInvite(): void {
  safeStorage()?.removeItem(INVITE_STORAGE_KEY);
}

/**
 * Publishes the code as a cookie for the one hop the URL cannot cross.
 *
 * Set on the console's origin, not the API's — a page cannot set a cookie for
 * another host. It works because both are subdomains of one registrable domain on
 * every real deployment, so `domain` is left unset and the browser scopes it to
 * this host; where the two origins are unrelated, OAuth sign-up simply carries no
 * code and the visitor is told so by the post-sign-up screen rather than silently
 * losing $100.
 */
export function publishInviteCookie(code: string): void {
  if (typeof document === 'undefined') return;
  const secure = globalThis.location?.protocol === 'https:' ? '; secure' : '';
  // biome-ignore lint/suspicious/noDocumentCookie: the Cookie Store API is Chromium-only, and this has to work in whatever browser the visitor opens
  document.cookie = `${INVITE_COOKIE_NAME}=${encodeURIComponent(normaliseInviteCode(code))}; max-age=${COOKIE_MAX_AGE_SECONDS}; path=/; samesite=lax${secure}`;
}

/**
 * Appends the code to a URL the sign-up will hand back to us.
 *
 * Better Auth's `callbackURL` is the only thing a magic-link sign-up carries from
 * the request that asked for the mail to the request that creates the account, so
 * the code rides in it (`sign-up-invite.ts`).
 */
export function withInvite(url: string, code: string | null): string {
  if (!code) return url;
  const target = new URL(url, 'http://console.invalid');
  target.searchParams.set(INVITE_QUERY_PARAM, code);
  return url.startsWith('http') ? target.toString() : `${target.pathname}${target.search}`;
}

/**
 * `localStorage`, or nothing.
 *
 * Reading it throws outright in a browser with storage blocked and in a server
 * render, and neither is a reason for the sign-up screen to fail: a visitor whose
 * browser has no storage still has the code in the URL, which is the source that
 * matters.
 */
function safeStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
