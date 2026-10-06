import { dump } from 'js-yaml';

/**
 * The rendered gatekeeper config that drives the egress sidecar (ADR-008 §5).
 *
 * Router-api holds the external endpoints in its database and the sidecar reads
 * them from a file, so this module is the whole of the contract between them. It
 * is pure on purpose: given rows and settings it returns a string, which is what
 * makes a golden file a meaningful test of the contract rather than of the
 * filesystem.
 *
 * Three properties the golden file pins, each one load-bearing:
 *
 *  - **`trust: cloud-measurement` on every endpoint.** The core's default policy
 *    requires a per-endpoint `trustedEvidence` digest pin, which is exactly the
 *    per-endpoint approval decision 1 removes. This mode says instead: admit on a
 *    verified attested root whose measurement is in the configured list. It is the
 *    weaker mode — a measurement admits a cloud, never a deployment (threat T13) —
 *    and it is never the default for the user-facing CLI.
 *  - **`failMode: closed` on every endpoint.** Decision 5. There is no setting
 *    that renders `open`, because an external upstream proxied without a verdict
 *    is the one thing this feature exists to prevent.
 *  - **no secrets.** The upstream API key is injected by router-api on the egress
 *    leg and the sidecar passes `Authorization` through untouched (ADR-003 §8), so
 *    the rendered file is readable without being sensitive. `rendersNoSecrets` in
 *    the spec is the standing check.
 *
 * The shape is `schemas/gatekeeper-config.schema.json` plus the two additions
 * ADR-008 §3 commits the core to: `attestedRoots.trustedMeasurements` (SUP-139)
 * and the per-endpoint `trust` mode. Validating a rendered file against the real
 * binary belongs to stage 2, where the two sides meet.
 */

/** The endpoint trust mode ADR-008 §3 adds to the core: the admin list decides, not a digest pin. */
export const CLOUD_MEASUREMENT_TRUST = 'cloud-measurement' as const;

/** Bounds the core keeps at its own defaults, written out so the file states them (ADR-008 §3). */
const MAX_BUNDLE_AGE = '24h';
const VERDICT_CACHE_TTL = '60s';

/** One enabled external endpoint, reduced to what the sidecar needs to know. */
export interface SidecarEndpointInput {
  name: string;
  /** `https://host[:port]`; the hostname is what evidence is fetched from and bound to. */
  baseUrl: string;
  listenPort: number;
}

export interface SidecarConfigInput {
  endpoints: readonly SidecarEndpointInput[];
  /** Normalised mrEnclave hex values from `trusted_measurements`. */
  trustedMeasurements: readonly string[];
  adminListen: string;
  /** Milliseconds; rendered in the Go duration grammar the config uses. */
  reattestIntervalMs: number;
}

/** The YAML document, as a value, so a test can assert on structure as well as bytes. */
export interface SidecarConfigDocument {
  version: 1;
  attestedRoots: { enabled: true; trustedMeasurements: string[] };
  defaults: { failMode: 'closed'; reattestInterval: string; verdictCacheTtl: string; maxBundleAge: string };
  admin: { listen: string };
  endpoints: Array<{
    name: string;
    listen: string;
    upstream: string;
    trust: typeof CLOUD_MEASUREMENT_TRUST;
    failMode: 'closed';
  }>;
}

export class UnrenderableEndpointError extends Error {
  constructor(name: string, reason: string) {
    super(`External endpoint "${name}" cannot be rendered into the sidecar config: ${reason}.`);
    this.name = 'UnrenderableEndpointError';
  }
}

/**
 * Milliseconds as the duration grammar `schemas/gatekeeper-config.schema.json`
 * accepts. Whole units where they divide, so the rendered file reads the way an
 * operator wrote it (`10m`, not `600000ms`).
 */
export function goDuration(ms: number): string {
  for (const [unit, size] of [
    ['h', 3_600_000],
    ['m', 60_000],
    ['s', 1_000],
  ] as const) {
    if (ms >= size && ms % size === 0) {
      return `${ms / size}${unit}`;
    }
  }
  return `${ms}ms`;
}

/**
 * The document the sidecar is given, as a plain value.
 *
 * Ordering is deterministic — endpoints by name, measurements sorted — because
 * the rendered file is compared against the one on disk to decide whether the
 * sidecar needs a reload, and a config that only reordered would re-attest every
 * endpoint for nothing.
 */
export function buildSidecarConfig(input: SidecarConfigInput): SidecarConfigDocument {
  const endpoints = [...input.endpoints]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((endpoint) => ({
      name: endpoint.name,
      // Loopback only: the listener is shared through the pod's network
      // namespace, so there is no Service and nothing leaves the pod.
      listen: `127.0.0.1:${endpoint.listenPort}`,
      upstream: upstreamOf(endpoint),
      trust: CLOUD_MEASUREMENT_TRUST,
      failMode: 'closed' as const,
    }));

  return {
    version: 1,
    attestedRoots: {
      // On, always: the whole verdict rests on the upstream root's own hardware
      // report, and the measurement check is a leg of that path.
      enabled: true,
      trustedMeasurements: [...new Set(input.trustedMeasurements)].sort(),
    },
    defaults: {
      failMode: 'closed',
      reattestInterval: goDuration(input.reattestIntervalMs),
      verdictCacheTtl: VERDICT_CACHE_TTL,
      maxBundleAge: MAX_BUNDLE_AGE,
    },
    admin: { listen: input.adminListen },
    endpoints,
  };
}

/** {@link buildSidecarConfig} serialised — the bytes that reach the shared volume. */
export function renderSidecarConfig(input: SidecarConfigInput): string {
  return [
    '# Rendered by router-api from external_endpoints and trusted_measurements.',
    '# Do not edit: every admin mutation overwrites this file (ADR-008 §5).',
    dump(buildSidecarConfig(input), { lineWidth: 0, noRefs: true, sortKeys: false }),
  ].join('\n');
}

/**
 * The `upstream` value: scheme and authority only, and it has to be `https`.
 *
 * The hostname is what the evidence bundle is fetched from and bound to, so a
 * plain-HTTP upstream is not a weaker version of this feature — there is no
 * channel to pin, and the verdict would be about nothing. Refusing here means a
 * row that cannot be attested never reaches the sidecar, rather than becoming a
 * silently `broken` endpoint.
 */
function upstreamOf(endpoint: SidecarEndpointInput): string {
  let url: URL;
  try {
    url = new URL(endpoint.baseUrl);
  } catch {
    throw new UnrenderableEndpointError(endpoint.name, `"${endpoint.baseUrl}" is not a URL`);
  }
  if (url.protocol !== 'https:') {
    throw new UnrenderableEndpointError(
      endpoint.name,
      'its base URL is not https, so there is no TLS channel to bind the evidence to',
    );
  }
  return `${url.protocol}//${url.host}`;
}
