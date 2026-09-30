import {
  CertChainError,
  fingerprintsEqual,
  type ParsedChain,
  rootFingerprintFromPem,
  validateChain,
  verifyJws,
} from '@confidential-router/attestation';
import { isMeasurementHex, lookUpMeasurement, type RegistryVerdict } from './sp-vm-registry';

/** The chain leaf, without pulling `@peculiar/x509` into the console's bundle twice. */
type ChainLeaf = ParsedChain['leaf'];

/**
 * Tier 1 of the chat's verification: the page checks the endpoint's evidence
 * itself, in the visitor's browser, before the composer will send anything.
 *
 * It runs the same TypeScript verifier the Chrome extension runs
 * (`@confidential-router/attestation`, which is the swarm-cloud
 * `swarm-attestation` port) — but as individual stages rather than through
 * `verifyHostname`, for one reason that matters: `verifyHostname` answers "does
 * this chain terminate at a root in my trust store", and a page served *by the
 * deployment it is checking* has no independent trust store to answer that with.
 * Pinning the root out of the very bundle under test would be a green tick that
 * proves nothing.
 *
 * So the root question is asked of something outside the deployment instead: the
 * signed sp-vm measurement registry (`sp-vm-registry.ts`), under a key pinned in
 * this bundle. When the platform publishes no TEE quote for a hostname — which is
 * the state of the demo cloud today, where `rootCaTeeQuote` is a
 * `{"status":"not-implemented"}` placeholder — that check reports `unavailable`
 * and the screen says so in words. It never reports a pass it did not get.
 *
 * What a pass here does and does not mean is spelled out in `tiers.ts`, which
 * owns every user-visible string. Nothing in this file is allowed to say
 * "verified" on its own.
 */

/** Rejected past this age, like the extension: producers republish every few minutes. */
export const MAX_BUNDLE_AGE_MS = 24 * 60 * 60 * 1000;

/** Producer and verifier clocks are allowed to disagree by this much. */
export const ALLOWED_CLOCK_SKEW_MS = 60_000;

export const EVIDENCE_PATH = '/.well-known/swarm-evidence';

export type CheckId = 'webcrypto' | 'bundle' | 'chain' | 'signature' | 'freshness' | 'binding' | 'root';

export type CheckStatus = 'pass' | 'fail' | 'unavailable';

export interface GateCheck {
  id: CheckId;
  status: CheckStatus;
  /** One sentence, written for the viewer, stating what was established. */
  detail: string;
}

/**
 * Where the bundle came from.
 *
 * `endpoint` is a direct fetch of the host's own `/.well-known/swarm-evidence`;
 * `router` is this router's unauthenticated passthrough of the last bundle it
 * retrieved. The signature is checked either way, so a bundle from the router
 * cannot be forged — but it can be *older* than what the host serves now, and a
 * viewer comparing digests with a gatekeeper deserves to know which they are
 * looking at.
 */
export type BundleSource = 'endpoint' | 'router';

export interface GateEvidence {
  hostname: string;
  source: BundleSource;
  issuedAt: string;
  evidenceDigest: string | null;
  certFingerprint: string;
  rootSubject: string | null;
  rootFingerprint: string | null;
  /** `rootCaTeeQuote.format`, or null when the platform published no usable quote. */
  quoteFormat: string | null;
  /** The measurement the registry was asked about, when the bundle published one. */
  measurement: string | null;
}

export interface GateResult {
  /** True when every check the page can run passed. The composer reads this. */
  unlocked: boolean;
  checks: GateCheck[];
  registry: RegistryVerdict | null;
  evidence: GateEvidence | null;
}

export interface GateOptions {
  hostname: string;
  /** Endpoint *name*, for the router's `GET /v1/evidence/:endpoint` fallback. */
  endpointName: string;
  /** router-api's origin, for that fallback. */
  apiOrigin: string;
  fetcher?: typeof fetch;
  now?: Date;
  /** Skips the network in tests; also the seam the extension bridge does not use. */
  registryLookup?: typeof lookUpMeasurement;
}

/**
 * The checks that must pass before the composer unlocks.
 *
 * `webcrypto` is absent on purpose: it is answered before any of these, by
 * returning early, so it never reaches this list — and adding it here would make
 * every happy path fail for want of a row nothing emits.
 */
const BLOCKING: readonly CheckId[] = ['bundle', 'chain', 'signature', 'freshness', 'binding'];

export async function runEvidenceGate(options: GateOptions): Promise<GateResult> {
  /*
   * Web Crypto first, because without it there is no verifier at all.
   *
   * Browsers expose `crypto.subtle` only in a secure context: HTTPS, or
   * `http://localhost`. A console served over plain HTTP on any *named* host —
   * a developer's `http://console.localtest.me:4300`, an operator's internal
   * hostname — therefore cannot verify anything, and every signature check below
   * would fail with "SubtleCrypto is not available", which reads as though the
   * deployment's evidence were bad. It is not: it is this page that cannot look.
   * Saying which is the whole point of the tier.
   */
  if (typeof globalThis.crypto?.subtle === 'undefined') {
    return {
      unlocked: false,
      checks: [
        {
          id: 'webcrypto',
          status: 'fail',
          detail:
            'This page is not served over a secure origin, so the browser withholds the Web Crypto API that ' +
            'verifying evidence needs. Nothing here has been checked — and nothing will be sent. Open the console ' +
            'over HTTPS, or on http://localhost, which browsers treat as secure.',
        },
      ],
      registry: null,
      evidence: null,
    };
  }

  const fetched = await fetchBundle(options);
  if (!fetched.ok) {
    return {
      unlocked: false,
      checks: [{ id: 'bundle', status: 'fail', detail: fetched.detail }],
      registry: null,
      evidence: null,
    };
  }

  const { bundle, source } = fetched;
  const checks: GateCheck[] = [
    {
      id: 'bundle',
      status: 'pass',
      detail:
        source === 'endpoint'
          ? `The host served a swarm-evidence v1 bundle for ${bundle.hostname}.`
          : `This router handed back the last bundle it retrieved for ${bundle.hostname}.`,
    },
  ];

  const chain = await checkChain(bundle, options.now);
  checks.push(chain.check);
  if (!chain.ok) {
    return { unlocked: false, checks, registry: null, evidence: null };
  }

  const signature = await checkSignature(bundle, chain.leaf);
  checks.push(signature.check);
  if (!signature.ok) {
    return { unlocked: false, checks, registry: null, evidence: null };
  }

  const payload = signature.payload;
  checks.push(checkFreshness(payload.issuedAt, options.now));
  checks.push(await checkBinding(payload.certFingerprint, bundle.tlsLeaf));

  const measurement = measurementOf(payload, bundle);
  const root = await checkRoot({
    quote: bundle.rootCaTeeQuote,
    measurement,
    rootSubject: chain.rootSubject,
    lookUp: options.registryLookup ?? lookUpMeasurement,
    fetcher: options.fetcher,
  });
  checks.push(root.check);

  return {
    unlocked: BLOCKING.every((id) => checks.find((check) => check.id === id)?.status === 'pass'),
    checks,
    registry: root.registry,
    evidence: {
      hostname: bundle.hostname,
      source,
      issuedAt: payload.issuedAt,
      evidenceDigest: 'evidenceDigest' in payload ? (payload.evidenceDigest as string) : null,
      certFingerprint: payload.certFingerprint,
      rootSubject: chain.rootSubject,
      rootFingerprint: chain.rootFingerprint,
      quoteFormat: quoteFormatOf(bundle.rootCaTeeQuote),
      measurement,
    },
  };
}

interface RawBundle {
  version: string;
  kind: string;
  hostname: string;
  issuedAt: string;
  certFingerprint: string;
  jws: string;
  certChain: string[];
  rootCaTeeQuote?: unknown;
  tlsLeaf?: string;
}

type FetchOutcome = { ok: true; bundle: RawBundle; source: BundleSource } | { ok: false; detail: string };

/**
 * The host first, this router second.
 *
 * A direct fetch is the better evidence and is what a gatekeeper would do, but it
 * is a cross-origin request to a host that does not have to allow one — so a CORS
 * refusal must degrade to the router's passthrough rather than leaving the screen
 * unable to verify anything. Which one answered is recorded and shown.
 */
async function fetchBundle(options: GateOptions): Promise<FetchOutcome> {
  const fetcher = options.fetcher ?? globalThis.fetch;
  if (typeof fetcher !== 'function') {
    return { ok: false, detail: 'This browser exposes no fetch, so no evidence could be retrieved.' };
  }

  const direct = await tryFetch(fetcher, `https://${options.hostname}${EVIDENCE_PATH}`, options.hostname);
  if (direct.ok) {
    return { ok: true, bundle: direct.bundle, source: 'endpoint' };
  }

  const base = options.apiOrigin.replace(/\/+$/, '');
  const relayed = await tryFetch(
    fetcher,
    `${base}/v1/evidence/${encodeURIComponent(options.endpointName)}`,
    options.hostname,
  );
  if (relayed.ok) {
    return { ok: true, bundle: relayed.bundle, source: 'router' };
  }

  return {
    ok: false,
    detail: `No evidence could be retrieved for ${options.hostname}: the host answered "${direct.detail}" and this router answered "${relayed.detail}".`,
  };
}

async function tryFetch(
  fetcher: typeof fetch,
  url: string,
  expectedHostname: string,
): Promise<{ ok: true; bundle: RawBundle } | { ok: false; detail: string }> {
  let response: Response;
  try {
    response = await fetcher(url, { headers: { accept: 'application/json' } });
  } catch (error) {
    return { ok: false, detail: (error as Error).message };
  }
  if (!response.ok) {
    return { ok: false, detail: `status ${response.status}` };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    return { ok: false, detail: `body is not JSON (${(error as Error).message})` };
  }
  return shapeOf(body, expectedHostname);
}

/**
 * The bundle's envelope shape, mirroring `schemas/swarm-evidence-bundle.schema.json`.
 *
 * Strict about the hostname and the members the verification stages consume, and
 * deliberately loose about `rootCaTeeQuote`: the demo cloud publishes a
 * placeholder object there, and a display field must not be able to fail a
 * bundle a gatekeeper would admit (SUP-157).
 */
function shapeOf(
  raw: unknown,
  expectedHostname: string,
): { ok: true; bundle: RawBundle } | { ok: false; detail: string } {
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, detail: 'the response is not a JSON object' };
  }
  const value = raw as Record<string, unknown>;
  if (value.version !== '1') {
    return { ok: false, detail: `unsupported bundle version ${String(value.version)}` };
  }
  if (value.kind !== 'DeploymentEvidence') {
    return { ok: false, detail: `unsupported bundle kind ${String(value.kind)}` };
  }
  if (value.hostname !== expectedHostname) {
    return { ok: false, detail: `the bundle names ${String(value.hostname)}, not ${expectedHostname}` };
  }
  if (typeof value.jws !== 'string' || value.jws.length === 0) {
    return { ok: false, detail: 'the bundle carries no JWS' };
  }
  if (typeof value.certFingerprint !== 'string' || !value.certFingerprint.startsWith('sha256/')) {
    return { ok: false, detail: 'the bundle certFingerprint is malformed' };
  }
  if (
    !Array.isArray(value.certChain) ||
    value.certChain.length === 0 ||
    !value.certChain.every((pem) => typeof pem === 'string' && pem.length > 0)
  ) {
    return { ok: false, detail: 'the bundle carries no certificate chain' };
  }
  if (typeof value.issuedAt !== 'string') {
    return { ok: false, detail: 'the bundle carries no issuedAt' };
  }

  return {
    ok: true,
    bundle: {
      version: '1',
      kind: 'DeploymentEvidence',
      hostname: value.hostname,
      issuedAt: value.issuedAt,
      certFingerprint: value.certFingerprint,
      jws: value.jws,
      certChain: value.certChain as string[],
      rootCaTeeQuote: value.rootCaTeeQuote,
      tlsLeaf: typeof value.tlsLeaf === 'string' ? value.tlsLeaf : undefined,
    },
  };
}

type ChainOutcome =
  | { ok: true; check: GateCheck; leaf: ChainLeaf; rootSubject: string; rootFingerprint: string }
  | { ok: false; check: GateCheck };

async function checkChain(bundle: RawBundle, now: Date | undefined): Promise<ChainOutcome> {
  try {
    const parsed = await validateChain(bundle.certChain, { now });
    return {
      ok: true,
      leaf: parsed.leaf,
      rootSubject: parsed.root.subject,
      rootFingerprint: parsed.rootFingerprint,
      check: {
        id: 'chain',
        status: 'pass',
        detail: `Each certificate signs the next, all are inside their validity window, and the chain terminates at the self-signed root ${parsed.root.subject}.`,
      },
    };
  } catch (error) {
    const message = error instanceof CertChainError ? error.message : (error as Error).message;
    return {
      ok: false,
      check: { id: 'chain', status: 'fail', detail: `The certificate chain is not valid: ${message}` },
    };
  }
}

type SignatureOutcome =
  | { ok: true; check: GateCheck; payload: { hostname: string; issuedAt: string; certFingerprint: string } }
  | { ok: false; check: GateCheck };

async function checkSignature(bundle: RawBundle, leaf: ChainLeaf): Promise<SignatureOutcome> {
  try {
    const payload = await verifyJws(bundle.jws, leaf);
    if (payload.hostname !== bundle.hostname) {
      return {
        ok: false,
        check: {
          id: 'signature',
          status: 'fail',
          detail: `The signed payload names ${payload.hostname}, not ${bundle.hostname}.`,
        },
      };
    }
    return {
      ok: true,
      payload,
      check: {
        id: 'signature',
        status: 'pass',
        detail: 'The evidence is signed by the key in the chain leaf, and the signed payload names this hostname.',
      },
    };
  } catch (error) {
    return {
      ok: false,
      check: { id: 'signature', status: 'fail', detail: `The signature did not verify: ${(error as Error).message}` },
    };
  }
}

function checkFreshness(issuedAt: string, now: Date | undefined): GateCheck {
  const issued = Date.parse(issuedAt);
  if (!Number.isFinite(issued)) {
    return { id: 'freshness', status: 'fail', detail: `The signed issuedAt "${issuedAt}" is not a timestamp.` };
  }
  const age = (now ?? new Date()).getTime() - issued;
  if (age > MAX_BUNDLE_AGE_MS) {
    return {
      id: 'freshness',
      status: 'fail',
      detail: `The evidence was signed ${Math.floor(age / 3_600_000)} hours ago, past the 24-hour window. A healthy deployment republishes every few minutes.`,
    };
  }
  if (age < -ALLOWED_CLOCK_SKEW_MS) {
    return {
      id: 'freshness',
      status: 'fail',
      detail: 'The evidence is dated in the future beyond allowed clock skew.',
    };
  }
  return {
    id: 'freshness',
    status: 'pass',
    detail: `The evidence was signed ${describeAge(age)} and is inside the 24-hour freshness window.`,
  };
}

/**
 * Producer-asserted channel binding, which is the only kind a page can do.
 *
 * A gatekeeper compares the signed `certFingerprint` with the certificate it
 * observes on its own TLS connection. A browser page cannot see that
 * certificate, so it does the next best thing the contract allows: hash the
 * `tlsLeaf` the producer publishes and check it against the signed fingerprint.
 * The trust boundary is "the producer asserts this is what it serves, and signs
 * that assertion" — strictly weaker, and labelled as such.
 */
async function checkBinding(signedFingerprint: string, tlsLeafPem: string | undefined): Promise<GateCheck> {
  if (!tlsLeafPem) {
    return {
      id: 'binding',
      status: 'fail',
      detail:
        'The bundle publishes no tlsLeaf, so the signed certificate fingerprint cannot be tied to any certificate from inside a browser.',
    };
  }
  try {
    // `rootFingerprintFromPem` is named for the job it was written for, but it is
    // just "PEM in, sha256/<base64url> out" — the same transform the fingerprint
    // in the signed payload was produced by.
    const derived = await rootFingerprintFromPem(tlsLeafPem);
    if (!fingerprintsEqual(signedFingerprint, derived)) {
      return {
        id: 'binding',
        status: 'fail',
        detail: `The published TLS certificate hashes to ${derived}, but the evidence signs ${signedFingerprint}.`,
      };
    }
    return {
      id: 'binding',
      status: 'pass',
      detail:
        'The TLS certificate the deployment publishes hashes to the fingerprint the evidence signs. This is a producer-asserted binding: a page cannot inspect the live TLS certificate, so it checks what the deployment says it serves.',
    };
  } catch (error) {
    return {
      id: 'binding',
      status: 'fail',
      detail: `The published tlsLeaf could not be parsed: ${(error as Error).message}`,
    };
  }
}

/**
 * Whether the root this chain terminates at belongs to a VM Super Protocol
 * vouches for — the one question the page cannot answer out of the bundle itself.
 */
async function checkRoot(input: {
  quote: unknown;
  measurement: string | null;
  rootSubject: string;
  lookUp: typeof lookUpMeasurement;
  fetcher: typeof fetch | undefined;
}): Promise<{ check: GateCheck; registry: RegistryVerdict | null }> {
  if (!input.measurement) {
    const format = quoteFormatOf(input.quote);
    return {
      registry: null,
      check: {
        id: 'root',
        status: 'unavailable',
        detail: format
          ? `The deployment publishes a ${format} quote but no measurement this page can look up, so nothing here says the root ${input.rootSubject} is one of Super Protocol's. Tiers 2 and 3 answer that.`
          : `The platform publishes no TEE quote for this hostname yet, so nothing here says the root ${input.rootSubject} is one of Super Protocol's. Tiers 2 and 3 answer that.`,
      },
    };
  }

  const verdict = await input.lookUp(input.measurement, { fetcher: input.fetcher });
  if (verdict.status === 'vouched') {
    return {
      registry: verdict,
      check: {
        id: 'root',
        status: 'pass',
        detail: `The measurement ${short(verdict.measurement)} is signed in Super Protocol's published registry under the key pinned in this page, so the VM behind ${input.rootSubject} is a build Super Protocol vouches for.`,
      },
    };
  }
  if (verdict.status === 'not-in-registry') {
    return {
      registry: verdict,
      check: {
        id: 'root',
        status: 'fail',
        detail: `The registry holds no valid signature for measurement ${short(verdict.measurement)}, so this VM is not one Super Protocol vouches for.`,
      },
    };
  }
  return {
    registry: verdict,
    check: {
      id: 'root',
      status: 'unavailable',
      detail: `Super Protocol's measurement registry could not be consulted (${verdict.reason}), so the root is neither confirmed nor rejected.`,
    },
  };
}

/**
 * The measurement to look up, from wherever the producer published it.
 *
 * The bundle contract does not fix a location, so the known ones are tried in
 * order of specificity — the same list `parseEvidenceBundle` reads for the
 * evidence modal — and only a value that is hex of the right length is used.
 */
function measurementOf(payload: unknown, bundle: RawBundle): string | null {
  const evidence = (payload as { evidence?: { measurements?: unknown } } | undefined)?.evidence;
  const candidates: unknown[] = [
    evidence?.measurements,
    (payload as { measurements?: unknown }).measurements,
    (bundle.rootCaTeeQuote as { collateral?: { measurements?: unknown } } | undefined)?.collateral?.measurements,
  ];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    for (const key of ['mrenclave', 'mrEnclave', 'MRENCLAVE']) {
      const value = (candidate as Record<string, unknown>)[key];
      if (typeof value === 'string' && isMeasurementHex(value.trim().toLowerCase())) {
        return value.trim().toLowerCase();
      }
    }
  }
  return null;
}

function quoteFormatOf(quote: unknown): string | null {
  const format = (quote as { format?: unknown } | undefined)?.format;
  return typeof format === 'string' && format.length > 0 ? format : null;
}

function describeAge(ageMs: number): string {
  const minutes = Math.max(0, Math.round(ageMs / 60_000));
  if (minutes < 1) return 'less than a minute ago';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'} ago`;
}

function short(hex: string): string {
  return `${hex.slice(0, 12)}…${hex.slice(-8)}`;
}
