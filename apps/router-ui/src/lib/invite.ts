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

import { publicConfig } from './public-config';

/** The query parameter the invitation URL uses, on both surfaces. */
export const INVITE_QUERY_PARAM = 'invite';

/** Where the console keeps the code between its own page loads. */
export const INVITE_STORAGE_KEY = 'cr_invite';

/**
 * Cookie the console sets before an OAuth redirect.
 *
 * An OAuth callback is a URL the provider built: none of our query parameters
 * survive it, and `localStorage` is not readable from the API origin that handles
 * it. A cookie both hosts can be reached at is the only thing that is — which is
 * why `sign-up-invite.ts` reads one, and why the `Domain` attribute is not
 * optional (see {@link inviteCookieScope}). It is strictly necessary for the
 * function the
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

export interface InviteCookieTarget {
  /** The host serving this page — `location.hostname`, no port. */
  consoleHost: string;
  /** The host router-api answers on, from the runtime public config. */
  apiHost: string;
  /** Whether this page is https. A `Secure` cookie set from http is dropped silently. */
  secure: boolean;
}

/**
 * The widest scope a cookie set here can have that still reaches the API, or
 * `null` for host-only.
 *
 * This is the whole difficulty of the OAuth hop. A cookie written with no
 * `Domain` attribute is **host-only** (RFC 6265 §5.3): the browser sends it back
 * to the exact host that set it and to nothing else. The console and the API are
 * *different hosts* on every real deployment —
 * `console.router.superprotocol.com` and `api.router.superprotocol.com` — so a
 * host-only `cr_invite` never arrives at the callback that needs it and the grant
 * is lost silently. It only appears to work where both apps share a host, which
 * is exactly what the compose demo and the e2e suite's loopback topology do.
 *
 * So the attribute is the longest suffix the two hosts share: the tightest scope
 * both can be reached at. `domain=router.superprotocol.com` is settable from the
 * console (a host may scope a cookie to any domain it sits under) and sent to the
 * API (a subdomain domain-matches it).
 *
 * `null` in three cases, all of which mean host-only is either right or the best
 * available:
 *
 *  - **the hosts are equal** — host-only already reaches the API and is narrower;
 *    this is the compose demo and `nx serve`;
 *  - **fewer than two shared labels** — `com` is a public suffix and `localhost` a
 *    bare name; browsers refuse a `Domain` of either;
 *  - **an IP literal** — `127.0.0.1` is not a domain and cannot be scoped to one.
 *
 * A deployment that puts the console and the API on unrelated registrable domains
 * lands in the second case: OAuth sign-up then carries no code, and the visitor is
 * told so by the post-sign-up screen rather than silently losing $100. Password
 * and magic-link sign-up are unaffected either way — they carry the code in the
 * request itself.
 */
export function inviteCookieScope(consoleHost: string, apiHost: string): string | null {
  const from = consoleHost.toLowerCase();
  const to = apiHost.toLowerCase();
  if (from.length === 0 || from === to) {
    return null;
  }

  const left = from.split('.').reverse();
  const right = to.split('.').reverse();
  const shared: string[] = [];
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    if (left[index].length === 0 || left[index] !== right[index]) break;
    shared.push(left[index]);
  }

  if (shared.length < 2 || shared.every((label) => /^\d+$/.test(label))) {
    return null;
  }
  return shared.reverse().join('.');
}

/**
 * The `document.cookie` string that publishes the code for the API to read.
 *
 * A pure function, because the attribute that matters is the one no local
 * topology can exercise: both apps share a host under compose and in the e2e
 * suite, which is the single arrangement where a host-only cookie crosses. The
 * only way to hold `domain=` to a real deployment's topology is to assert on the
 * string.
 *
 * `SameSite=Lax` is deliberate and sufficient: the OAuth callback reaches the API
 * as a top-level GET navigation, which Lax permits, and nothing else should ever
 * carry this cookie.
 */
export function inviteCookie(code: string, target: InviteCookieTarget): string {
  const scope = inviteCookieScope(target.consoleHost, target.apiHost);

  return [
    `${INVITE_COOKIE_NAME}=${encodeURIComponent(normaliseInviteCode(code))}`,
    `max-age=${COOKIE_MAX_AGE_SECONDS}`,
    'path=/',
    'samesite=lax',
    ...(scope ? [`domain=${scope}`] : []),
    ...(target.secure ? ['secure'] : []),
  ].join('; ');
}

/**
 * Publishes the code as a cookie for the one hop the URL cannot cross.
 *
 * An OAuth callback is a URL the provider built: none of our query parameters
 * survive it, and `localStorage` is not readable from the API origin that handles
 * it. A cookie both hosts can be reached at is the only thing that is — see
 * {@link inviteCookieScope} for why the `Domain` attribute is load-bearing rather
 * than optional.
 */
export function publishInviteCookie(code: string): void {
  if (typeof document === 'undefined') return;

  // biome-ignore lint/suspicious/noDocumentCookie: the Cookie Store API is Chromium-only, and this has to work in whatever browser the visitor opens
  document.cookie = inviteCookie(code, {
    consoleHost: globalThis.location?.hostname ?? '',
    apiHost: apiHostOf(),
    secure: globalThis.location?.protocol === 'https:',
  });
}

/**
 * The API's host, or an empty string.
 *
 * `apiOrigin` is an operator's value and is a URL on every deployment; one that
 * does not parse leaves the cookie host-only rather than throwing out of a
 * sign-in the visitor has already started.
 */
function apiHostOf(): string {
  try {
    return new URL(publicConfig().apiOrigin).hostname;
  } catch {
    return '';
  }
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
