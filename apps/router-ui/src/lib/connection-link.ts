/**
 * The connection link a model-serving marketplace app emits, parsed.
 *
 * Format, refusals and the reasoning behind both:
 * `docs/contracts/connection-link.md`. The vectors in
 * `docs/contracts/connection-link-vectors.json` are the shared truth this
 * implementation and the producer side are both tested against — change the
 * vectors first.
 */

/** Every way a paste can be refused. Each maps to one sentence in the dialog. */
export type ConnectionLinkRefusal =
  | 'not_a_url'
  | 'insecure_scheme'
  | 'key_in_query'
  | 'missing_fragment'
  | 'duplicate_param'
  | 'empty_value'
  | 'missing_key'
  | 'missing_model';

export interface ConnectionLink {
  /** Origin plus any path that is not the `/v1` surface — `ExternalEndpoint.baseUrl`. */
  baseUrl: string;
  modelId: string;
  /** The upstream's API key. A credential: see the handling rules in the contract. */
  apiKey: string;
  /** Kebab-case suggestion for the endpoint name, which is also the sidecar's endpoint key. */
  suggestedName: string;
}

export type ConnectionLinkResult = { ok: true; link: ConnectionLink } | { ok: false; reason: ConnectionLinkRefusal };

/**
 * Query parameter names that may carry key material. A link that puts the
 * credential here has already leaked it into access logs and `Referer` headers,
 * so it is refused rather than accepted with a warning.
 */
const SECRET_QUERY_NAMES = new Set(['key', 'api_key', 'apikey', 'token', 'access_token']);

/** What the admin section shows for each refusal. */
const REFUSAL_MESSAGES: Record<ConnectionLinkRefusal, string> = {
  not_a_url: 'That does not look like a link. Paste the whole connection link, starting with https://.',
  insecure_scheme:
    'A connection link must be https. The router pins the upstream’s certificate, which http cannot offer.',
  key_in_query:
    'This link carries the key in its query string, where server logs and referrers can see it. Treat that key as disclosed, rotate it upstream, and paste a link that carries it after the #.',
  missing_fragment: 'This link has no "#key=…&model=…" part, so there is nothing to fill in.',
  duplicate_param: 'This link names "key" or "model" twice, so which one was meant is a guess. Ask for a fresh link.',
  empty_value: 'This link has an empty "key" or "model".',
  missing_key: 'This link has no "key" value.',
  missing_model: 'This link has no "model" value.',
};

export function connectionLinkRefusalMessage(reason: ConnectionLinkRefusal): string {
  return REFUSAL_MESSAGES[reason];
}

/**
 * Parses the fragment as `&`-separated `name=value` pairs.
 *
 * Deliberately not `URLSearchParams`: its `application/x-www-form-urlencoded`
 * rules turn `+` into a space, which silently corrupts every base64 API key that
 * contains one. A pair with no `=` is recorded with an empty value, so `#key`
 * refuses as `empty_value` rather than being read as something it is not.
 */
function parseFragment(fragment: string): Map<string, string[]> {
  const params = new Map<string, string[]>();

  for (const pair of fragment.split('&')) {
    if (pair === '') continue;
    const separator = pair.indexOf('=');
    const rawName = separator === -1 ? pair : pair.slice(0, separator);
    const rawValue = separator === -1 ? '' : pair.slice(separator + 1);

    let name: string;
    let value: string;
    try {
      name = decodeURIComponent(rawName);
      value = decodeURIComponent(rawValue);
    } catch {
      // A lone `%` is not a URL component; treat the pair as unreadable rather
      // than throwing out of the parser.
      continue;
    }

    const existing = params.get(name);
    if (existing) existing.push(value);
    else params.set(name, [value]);
  }

  return params;
}

/**
 * `qwen3-coder.swarm.superprotocol.dev` → `qwen3-coder-swarm-superprotocol-dev`.
 * A suggestion only — the dialog lets the admin rename before submitting.
 */
export function suggestedEndpointName(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/** Strips the `/v1` surface, keeping any other path as a prefix. */
export function baseUrlOf(url: URL): string {
  const path = url.pathname.replace(/\/+$/, '');
  const prefix = path.endsWith('/v1') ? path.slice(0, -'/v1'.length) : path;
  return `${url.origin}${prefix}${url.search}`;
}

export function parseConnectionLink(input: string): ConnectionLinkResult {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return { ok: false, reason: 'not_a_url' };
  }

  if (url.protocol !== 'https:') return { ok: false, reason: 'insecure_scheme' };

  for (const name of url.searchParams.keys()) {
    if (SECRET_QUERY_NAMES.has(name.toLowerCase())) return { ok: false, reason: 'key_in_query' };
  }

  const fragment = url.hash.replace(/^#/, '');
  if (fragment === '') return { ok: false, reason: 'missing_fragment' };

  const params = parseFragment(fragment);
  const keys = params.get('key');
  const models = params.get('model');

  if ((keys && keys.length > 1) || (models && models.length > 1)) return { ok: false, reason: 'duplicate_param' };

  // Trimmed because a clipboard round trip is the usual source of a stray space,
  // and an API key is never meant to end in one.
  const apiKey = keys?.[0]?.trim() ?? null;
  const modelId = models?.[0]?.trim() ?? null;

  if ((keys && apiKey === '') || (models && modelId === '')) return { ok: false, reason: 'empty_value' };
  if (apiKey === null) return { ok: false, reason: 'missing_key' };
  if (modelId === null) return { ok: false, reason: 'missing_model' };

  return {
    ok: true,
    link: {
      baseUrl: baseUrlOf(url),
      modelId,
      apiKey,
      suggestedName: suggestedEndpointName(url.hostname),
    },
  };
}
