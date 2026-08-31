import { API_ORIGIN, AUTH_CALLBACK_URL } from './env';

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
    response = await fetch(`${API_ORIGIN}/auth${path}`, {
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
    callbackURL: AUTH_CALLBACK_URL,
  })) as { url?: unknown };

  if (typeof result.url !== 'string') {
    throw new AuthRequestError(`${provider} sign-in is not configured on this deployment.`);
  }

  window.location.assign(result.url);
}

/** Mails a magic link. Resolves once the mail is accepted — never with a session. */
export async function signInWithMagicLink(email: string): Promise<void> {
  await postToAuth('/sign-in/magic-link', { email, callbackURL: AUTH_CALLBACK_URL });
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
  await postToAuth('/sign-out', {});
}
