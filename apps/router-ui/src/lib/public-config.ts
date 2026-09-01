/**
 * Browser-visible configuration, resolved at run time.
 *
 * It used to be three `NEXT_PUBLIC_*` variables, which `next build` inlines into
 * the client bundle — so a console image was bound to the one API origin it was
 * built against. The marketplace listing cannot live with that: an image
 * reference pinned by digest and a hostname the customer chooses at deploy time
 * are the same requirement pulling in opposite directions (SUP-100).
 *
 * So the values are ordinary server-side environment variables now. The root
 * layout reads them per request and writes them into the document as an inline
 * script; everything here reads them lazily, never at module evaluation, so a
 * consumer imported before that script runs still sees the right value when it
 * is finally asked. One published digest serves any origin.
 */

export interface PublicConfig {
  /** router-api's origin. Better Auth is mounted under `<origin>/auth` (ADR-004). */
  apiOrigin: string;
  /** router-api's GraphQL endpoint. */
  graphqlHttp: string;
  /** Where Better Auth sends the browser back after a social or magic-link sign-in. */
  authCallbackUrl: string;
}

/** The global the root layout writes and {@link publicConfig} reads. */
export const PUBLIC_CONFIG_GLOBAL = '__ROUTER_UI_PUBLIC_CONFIG__';

/** Where an unconfigured console looks for the API — the compose demo's port. */
export const DEFAULT_API_ORIGIN = 'http://127.0.0.1:3000';

/** `process` is not guaranteed to exist in the browser bundle. */
function environment(): Record<string, string | undefined> {
  return typeof process === 'undefined' ? {} : process.env;
}

function setting(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * The configuration the server is running with. `ROUTER_UI_GRAPHQL_HTTP` exists
 * for the deployment that puts GraphQL somewhere other than `<origin>/graphql`;
 * everything else only ever needs to set `ROUTER_UI_API_ORIGIN`.
 */
export function readPublicConfig(env: Record<string, string | undefined> = environment()): PublicConfig {
  const apiOrigin = (setting(env.ROUTER_UI_API_ORIGIN) ?? DEFAULT_API_ORIGIN).replace(/\/+$/, '');

  return {
    apiOrigin,
    graphqlHttp: setting(env.ROUTER_UI_GRAPHQL_HTTP) ?? `${apiOrigin}/graphql`,
    authCallbackUrl: setting(env.ROUTER_UI_AUTH_CALLBACK_URL) ?? '/',
  };
}

function isPublicConfig(value: unknown): value is PublicConfig {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<PublicConfig>;

  return (
    typeof candidate.apiOrigin === 'string' &&
    typeof candidate.graphqlHttp === 'string' &&
    typeof candidate.authCallbackUrl === 'string'
  );
}

/**
 * What this page was configured with. Call it where the value is used — holding
 * the result in a module constant would re-create the build-time binding this
 * replaced, one layer down.
 *
 * The fallback to {@link readPublicConfig} covers the server render of a client
 * component, which happens before the browser has the inline script: reading the
 * same environment there is what keeps the markup and the hydration identical.
 */
export function publicConfig(): PublicConfig {
  const injected = (globalThis as unknown as Record<string, unknown>)[PUBLIC_CONFIG_GLOBAL];

  return isPublicConfig(injected) ? injected : readPublicConfig();
}

/**
 * The inline script the root layout emits.
 *
 * The values are the operator's, not a visitor's, but they still land inside a
 * `<script>` element: `<` is escaped so no value can close it, and the two
 * Unicode line terminators because JSON allows them raw and JavaScript does not.
 */
export function publicConfigScript(config: PublicConfig): string {
  const json = JSON.stringify(config)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

  return `window.${PUBLIC_CONFIG_GLOBAL}=${json};`;
}
