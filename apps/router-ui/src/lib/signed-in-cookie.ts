/**
 * The console's own "this browser believes it has a session" marker.
 *
 * router-api's session cookie cannot serve as one. It is HttpOnly and set on the
 * *API* origin, which on every real deployment is a different hostname than the
 * console's — `console.example.com` never receives `api.example.com`'s cookies —
 * and over https Better Auth prefixes the name, so it is not even called
 * `cr_session` there. A proxy looking for that cookie on the console host
 * therefore found nothing on exactly the deployments that matter, and bounced a
 * freshly signed-in browser back to `/login` for ever (SUP-113).
 *
 * So the console keeps its own marker, on its own host: raised after a sign-in
 * the console performed, cleared on sign-out and on the first unauthenticated
 * answer. It is a routing convenience and not a credential — not HttpOnly,
 * because the client has to write it; carrying no identity, because it names no
 * session; and router-api still authorises every request on its own.
 *
 * Both ways of falling out of step heal themselves. A marker without a session
 * is cleared by the next API answer; a session without a marker is restored by
 * `<ResumeSession />` on the sign-in screen.
 */
export const SIGNED_IN_COOKIE_NAME = 'cr_signed_in';

/** ADR-004 §4's session is 30 days rolling; on either side of that, see above. */
const MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/**
 * `Secure` only where the page itself is. A `Secure` cookie set from an http
 * page is dropped without a word, and both the compose demo and the e2e stack
 * serve the console over plain http — the marker has to work there too.
 */
function attributes(): string {
  return `path=/; samesite=lax${globalThis.location?.protocol === 'https:' ? '; secure' : ''}`;
}

export function markSignedIn(): void {
  if (typeof document === 'undefined') return;
  // biome-ignore lint/suspicious/noDocumentCookie: the Cookie Store API is Chromium-only, and this has to work in whatever browser the deployment's operator opens
  document.cookie = `${SIGNED_IN_COOKIE_NAME}=1; max-age=${MAX_AGE_SECONDS}; ${attributes()}`;
}

export function clearSignedIn(): void {
  if (typeof document === 'undefined') return;
  // biome-ignore lint/suspicious/noDocumentCookie: the Cookie Store API is Chromium-only, and this has to work in whatever browser the deployment's operator opens
  document.cookie = `${SIGNED_IN_COOKIE_NAME}=; max-age=0; ${attributes()}`;
}
