/**
 * Finding the invitation code on the request that created an account.
 *
 * Redemption is not an endpoint. It happens inside account creation — Better
 * Auth's `databaseHooks.user.create.after` — so that a client cannot replay it,
 * cannot call it for an account it did not just create, and cannot have the
 * grant without the account (`docs/router.md`, "Invitation codes").
 *
 * The cost of living there is that the code has to be recovered from whichever
 * request happened to create the user, and the three sign-in paths carry
 * different things:
 *
 *  - **password** — `POST /auth/sign-up/email`, the console's own request, so the
 *    code can ride the body or the query string;
 *  - **magic link** — `GET /auth/magic-link/verify?token=…&callbackURL=…`, where
 *    the only thing the console chose is `callbackURL`, carried through from the
 *    sign-in request;
 *  - **OAuth** — `GET /auth/callback/<provider>?code=…&state=…`, a URL the
 *    provider built, where nothing of ours survives except a cookie on this
 *    origin.
 *
 * Hence four sources, in that order. All of them are advisory: whatever comes
 * out is a candidate string, and `InviteService` decides whether it is a code.
 */

/**
 * Cookie the console sets on its own origin, immediately before an OAuth
 * redirect, so the code survives the round trip. Not the landing page's: that
 * surface sets nothing and hands the code on in the URL, which is what keeps its
 * published "no cookie" claim true (ADR-006 §4).
 */
export const INVITE_COOKIE_NAME = 'cr_invite';

/** Query parameter the invitation URL uses, and the console appends to sign-up. */
export const INVITE_QUERY_PARAM = 'invite';

/** Body field the console's password sign-up may send instead. */
export const INVITE_BODY_FIELD = 'inviteCode';

/** Anything with header access: a `Headers`, or a test double. */
export interface HeaderBag {
  get(name: string): string | null;
}

/**
 * The slice of Better Auth's `GenericEndpointContext` this reads. Declared
 * structurally so the extraction can be tested without constructing one.
 */
export interface SignUpRequestContext {
  body?: unknown;
  query?: unknown;
  headers?: HeaderBag | null;
  request?: { headers?: HeaderBag | null } | null;
}

/** What the redemption needs from the request that created the account. */
export interface SignUpInvite {
  /** Raw candidate, not yet normalised or validated. */
  code: string | null;
  /** For the abuse-review fingerprint; hashed before it is stored. */
  ip: string | null;
  userAgent: string | null;
}

export const NO_SIGN_UP_INVITE: SignUpInvite = { code: null, ip: null, userAgent: null };

export function signUpInviteOf(context: SignUpRequestContext | null | undefined): SignUpInvite {
  if (!context) {
    return NO_SIGN_UP_INVITE;
  }
  const headers = context.headers ?? context.request?.headers ?? null;
  return {
    code: inviteCodeOf(context, headers),
    ip: clientIpOf(headers),
    userAgent: headers?.get('user-agent') ?? null,
  };
}

function inviteCodeOf(context: SignUpRequestContext, headers: HeaderBag | null): string | null {
  const body = asRecord(context.body);
  const query = asRecord(context.query);
  return (
    asCode(body?.[INVITE_BODY_FIELD]) ??
    asCode(query?.[INVITE_QUERY_PARAM]) ??
    asCode(query?.[INVITE_BODY_FIELD]) ??
    inviteCodeInCallback(query?.callbackURL) ??
    inviteCookie(headers)
  );
}

/**
 * The `invite` parameter of a `callbackURL`, which may be a path (`/?invite=X`)
 * rather than an absolute URL — so it is parsed against a base that is thrown
 * away. A `callbackURL` that does not parse is a client mistake, not a reason to
 * fail an account creation that has already happened.
 */
function inviteCodeInCallback(value: unknown): string | null {
  const callbackUrl = asCode(value);
  if (!callbackUrl) {
    return null;
  }
  try {
    return asCode(new URL(callbackUrl, 'http://invite.invalid').searchParams.get(INVITE_QUERY_PARAM));
  } catch {
    return null;
  }
}

function inviteCookie(headers: HeaderBag | null): string | null {
  const header = headers?.get('cookie');
  if (!header) {
    return null;
  }
  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');
    if (separator > 0 && pair.slice(0, separator).trim() === INVITE_COOKIE_NAME) {
      return asCode(decodeURIComponent(pair.slice(separator + 1).trim()));
    }
  }
  return null;
}

/**
 * The caller's address as the proxy reported it, first hop only.
 *
 * `x-forwarded-for` is a client-controlled header; the deployment terminates TLS
 * behind one proxy (`trust proxy: 1`), which overwrites the first entry. It is
 * only ever hashed into an abuse-review column, never trusted for a decision, so
 * a spoofed value costs nothing but a useless fingerprint.
 */
function clientIpOf(headers: HeaderBag | null): string | null {
  const forwarded = headers?.get('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim();
  return first || headers?.get('x-real-ip') || null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/** A non-empty string, or nothing. Keeps `?? ` chains from falling for `''`. */
function asCode(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}
