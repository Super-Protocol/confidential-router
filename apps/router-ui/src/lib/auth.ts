import { publicConfig } from './public-config';
import { clearSignedIn, markSignedIn } from './signed-in-cookie';

export type SocialProvider = 'github' | 'google';

export class AuthRequestError extends Error {
  /** HTTP status of the failed response, when there was one to read. */
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'AuthRequestError';
    this.status = status;
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
    // Better Auth returns `{ message }` on failure. Anything else (a proxy error
    // page, say) must not be shown to the viewer verbatim.
    const detail = await response
      .json()
      .then((body: { message?: unknown }) => (typeof body?.message === 'string' ? body.message : null))
      .catch(() => null);
    throw new AuthRequestError(detail ?? 'Sign-in failed. Please try again.', response.status);
  }

  return response.json().catch(() => ({}));
}

/**
 * Starts an OAuth sign-in. Better Auth answers with the provider's authorize
 * URL rather than a redirect, so the caller navigates.
 */
export async function signInWithProvider(provider: SocialProvider): Promise<void> {
  const result = (await postToAuth('/sign-in/social', {
    provider,
    callbackURL: publicConfig().authCallbackUrl,
  })) as { url?: unknown };

  if (typeof result.url !== 'string') {
    throw new AuthRequestError(`${provider} sign-in is not configured on this deployment.`);
  }

  window.location.assign(result.url);
}

/** Mails a magic link. Resolves once the mail is accepted — never with a session. */
export async function signInWithMagicLink(email: string): Promise<void> {
  await postToAuth('/sign-in/magic-link', { email, callbackURL: publicConfig().authCallbackUrl });
}

/**
 * Creates an account from an address and a password, and signs it in.
 *
 * No verification mail is sent and none is waited for: this path exists for the
 * deployment that cannot send one, so the session arrives with the sign-up
 * itself. Only reachable while `signInOptions.password` is true — the router
 * answers 404 on a deployment that did not enable passwords.
 *
 * `name` is optional to the console and required by Better Auth's body schema,
 * which accepts an empty string; the console lets it be filled in later.
 */
export async function signUpWithPassword(input: { email: string; password: string; name?: string }): Promise<void> {
  await postToAuth('/sign-up/email', {
    email: input.email,
    password: input.password,
    name: input.name?.trim() ?? '',
    callbackURL: publicConfig().authCallbackUrl,
  });
}

/** Signs an existing account in with its password. The session arrives as a cookie. */
export async function signInWithPassword(email: string, password: string): Promise<void> {
  await postToAuth('/sign-in/email', { email, password, callbackURL: publicConfig().authCallbackUrl });
}

/**
 * Trades the deployment's bootstrap token for the first account and a session.
 *
 * Only reachable while `signInOptions.bootstrap` is true: the router registers
 * the endpoint at all only when a token is configured, and answers 404 once any
 * user exists. Nothing is returned — the session arrives as a cookie, exactly
 * as it does from a magic link.
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
export function signInDestination(search: string = globalThis.location?.search ?? ''): string {
  const next = new URLSearchParams(search).get('next');
  const local = next?.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\');

  return local ? (next as string) : publicConfig().authCallbackUrl;
}

/**
 * Finishes a sign-in the console itself performed: raise the console-host marker
 * `proxy.ts` routes on, then leave for the destination.
 *
 * A full navigation rather than a router push, because the session cookie was
 * just set on the API origin and every cached Apollo result on this page was
 * fetched without one.
 */
export function completeSignIn(): void {
  markSignedIn();
  window.location.assign(signInDestination());
}
