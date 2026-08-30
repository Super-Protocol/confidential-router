/**
 * The verification pipeline: fetch → cert chain → trusted root → JWS → freshness →
 * channel binding.
 *
 * Ported from Super-Protocol/swarm-cloud `libs/swarm-attestation/src/verify.ts`
 * (BSL-1.1) with permission; see the repository NOTICE. The Go verifier in
 * `apps/gatekeeper/pkg/attestation` implements the same stages and is held to the
 * same conformance vectors (`@confidential-router/attestation-fixtures`).
 */
import { X509Certificate } from '@peculiar/x509';
import { buildCacheKey } from './cache.js';
import { CertChainError, rootFingerprintFromPem, validateChain } from './cert-chain.js';
import { fail } from './errors.js';
import { fingerprintsEqual, isFingerprint, sha256Fingerprint } from './fingerprint.js';
import { JwsError, verifyJws } from './jws.js';
import type {
  AttestationBundle,
  ChannelBinding,
  EvidenceKind,
  EvidencePayload,
  TrustedRoot,
  VerifyParams,
  VerifyResult,
} from './types.js';

export const EVIDENCE_PATH = '/.well-known/swarm-evidence';

const KIND_VALUES = new Set<EvidenceKind>([
  'DeploymentEvidence',
  'ControlPlaneEvidence',
  'KubernetesControlPlaneEvidence',
]);
// Tolerance for benign clock skew between producer and verifier when `maxBundleAge` is
// set. A bundle dated up to this much in the future is still accepted; anything beyond
// is treated as a freshness violation.
export const ALLOWED_CLOCK_SKEW_MS = 60_000;

type StageResult<T> = ({ ok: true } & T) | { ok: false; err: VerifyResult };

export async function verifyHostname(params: VerifyParams): Promise<VerifyResult> {
  const { hostname, observedTlsFingerprint, trustedRoots, cache } = params;

  if (typeof hostname !== 'string' || hostname.length === 0) {
    return fail('fetch', 'hostname must be a non-empty string');
  }
  if (observedTlsFingerprint !== undefined && !isFingerprint(observedTlsFingerprint)) {
    return fail('tls-fingerprint', 'observedTlsFingerprint must match sha256/<base64url>');
  }
  if (!Array.isArray(trustedRoots)) {
    return fail('untrusted-root', 'trustedRoots must be an array (may be empty)');
  }

  const baseCacheKey = cache ? await buildCacheKey(hostname, observedTlsFingerprint ?? null, trustedRoots) : null;
  // Different age policies must not share cached results — a permissive caller's "ok"
  // could otherwise satisfy a stricter caller for a bundle that has since exceeded the
  // stricter window.
  const cacheKey = baseCacheKey ? `${baseCacheKey}|${params.maxBundleAge ?? ''}` : null;
  if (cache && cacheKey) {
    const hit = cache.get(cacheKey);
    if (hit) return hit;
  }

  const result = await runPipeline(params);

  if (cache && cacheKey && result.ok) {
    cache.set(cacheKey, result);
  }
  return result;
}

async function runPipeline(params: VerifyParams): Promise<VerifyResult> {
  const fetched = await fetchBundle(params);
  if (!fetched.ok) return fetched.err;
  const bundle = fetched.bundle;

  const chain = await runCertChainStage(bundle, params.now);
  if (!chain.ok) return chain.err;

  const trust = await runTrustedRootStage(chain.rootFingerprint, params.trustedRoots);
  if (!trust.ok) return trust.err;

  const jws = await runJwsStage(bundle, chain.leaf, params.hostname);
  if (!jws.ok) return jws.err;

  const freshness = runFreshnessStage(jws.payload.issuedAt, params.maxBundleAge, params.now);
  if (!freshness.ok) return freshness.err;

  const tls = await runTlsFingerprintStage(jws.payload.certFingerprint, params.observedTlsFingerprint, bundle.tlsLeaf);
  if (!tls.ok) return tls.err;

  return {
    ok: true,
    kind: jws.payload.kind,
    payload: jws.payload,
    matchedRoot: trust.matchedRoot,
    rootCaTeeQuote: bundle.rootCaTeeQuote,
    channelBinding: tls.channelBinding,
  };
}

async function fetchBundle(params: VerifyParams): Promise<StageResult<{ bundle: AttestationBundle }>> {
  const url = `https://${params.hostname}${EVIDENCE_PATH}`;
  const fetcher = params.fetcher ?? globalThis.fetch;
  if (typeof fetcher !== 'function') {
    return {
      ok: false,
      err: fail('fetch', 'no fetcher available; pass params.fetcher or run with global fetch'),
    };
  }

  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
  } catch (err) {
    return { ok: false, err: fail('fetch', `request failed: ${(err as Error).message}`) };
  }

  if (!response.ok) {
    return {
      ok: false,
      err: fail('fetch', `unexpected status ${response.status} from ${url}`),
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    return {
      ok: false,
      err: fail('fetch', `failed to parse response body as JSON: ${(err as Error).message}`),
    };
  }

  return validateBundleShape(body, params.hostname);
}

function validateBundleShape(raw: unknown, expectedHostname: string): StageResult<{ bundle: AttestationBundle }> {
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, err: fail('fetch', 'response body is not a JSON object') };
  }
  const v = raw as Record<string, unknown>;
  if (v.version !== '1') {
    return { ok: false, err: fail('fetch', `unsupported bundle version: ${String(v.version)}`) };
  }
  if (typeof v.kind !== 'string' || !KIND_VALUES.has(v.kind as EvidenceKind)) {
    return { ok: false, err: fail('fetch', `unsupported bundle kind: ${String(v.kind)}`) };
  }
  if (typeof v.hostname !== 'string' || v.hostname.length === 0) {
    return { ok: false, err: fail('fetch', 'bundle is missing hostname') };
  }
  if (v.hostname !== expectedHostname) {
    return {
      ok: false,
      err: fail('fetch', `bundle hostname "${v.hostname}" does not match request hostname`),
    };
  }
  if (typeof v.issuedAt !== 'string') {
    return { ok: false, err: fail('fetch', 'bundle is missing issuedAt') };
  }
  if (typeof v.certFingerprint !== 'string' || !v.certFingerprint.startsWith('sha256/')) {
    return { ok: false, err: fail('fetch', 'bundle certFingerprint is malformed') };
  }
  if (typeof v.jws !== 'string' || v.jws.length === 0) {
    return { ok: false, err: fail('fetch', 'bundle is missing jws') };
  }
  if (
    !Array.isArray(v.certChain) ||
    v.certChain.length === 0 ||
    !v.certChain.every((p) => typeof p === 'string' && p.length > 0)
  ) {
    return { ok: false, err: fail('fetch', 'bundle certChain is missing or malformed') };
  }
  if (v.rootCaTeeQuote !== undefined && (typeof v.rootCaTeeQuote !== 'object' || v.rootCaTeeQuote === null)) {
    return { ok: false, err: fail('fetch', 'bundle rootCaTeeQuote is malformed') };
  }
  if (v.tlsLeaf !== undefined && (typeof v.tlsLeaf !== 'string' || v.tlsLeaf.length === 0)) {
    return { ok: false, err: fail('fetch', 'bundle tlsLeaf is malformed') };
  }
  return {
    ok: true,
    bundle: {
      version: '1',
      kind: v.kind as EvidenceKind,
      hostname: v.hostname,
      issuedAt: v.issuedAt,
      certFingerprint: v.certFingerprint,
      jws: v.jws,
      certChain: v.certChain as string[],
      rootCaTeeQuote: v.rootCaTeeQuote as AttestationBundle['rootCaTeeQuote'],
      tlsLeaf: v.tlsLeaf as string | undefined,
    },
  };
}

async function runCertChainStage(
  bundle: AttestationBundle,
  now: Date | undefined,
): Promise<StageResult<{ rootFingerprint: string; leaf: X509Certificate }>> {
  try {
    const parsed = await validateChain(bundle.certChain, { now });
    return { ok: true, rootFingerprint: parsed.rootFingerprint, leaf: parsed.leaf };
  } catch (err) {
    if (err instanceof CertChainError) {
      return { ok: false, err: fail('cert-chain', err.message) };
    }
    return { ok: false, err: fail('cert-chain', `unexpected error: ${(err as Error).message}`) };
  }
}

async function runTrustedRootStage(
  rootFingerprint: string,
  trustedRoots: TrustedRoot[],
): Promise<StageResult<{ matchedRoot: { name: string; fingerprint: string } }>> {
  for (const root of trustedRoots) {
    let fp: string;
    try {
      fp = await rootFingerprintFromPem(root.pem);
    } catch (err) {
      return {
        ok: false,
        err: fail('untrusted-root', `failed to parse trusted root "${root.name}": ${(err as Error).message}`),
      };
    }
    if (fingerprintsEqual(fp, rootFingerprint)) {
      return { ok: true, matchedRoot: { name: root.name, fingerprint: fp } };
    }
  }
  return {
    ok: false,
    err: fail('untrusted-root', `${rootFingerprint} not in trusted store`),
  };
}

async function runJwsStage(
  bundle: AttestationBundle,
  leaf: X509Certificate,
  expectedHostname: string,
): Promise<StageResult<{ payload: EvidencePayload }>> {
  try {
    const payload = await verifyJws(bundle.jws, leaf);
    if (payload.kind !== bundle.kind) {
      return {
        ok: false,
        err: fail('jws', `payload kind "${payload.kind}" does not match bundle kind "${bundle.kind}"`),
      };
    }
    if (payload.hostname !== expectedHostname) {
      return {
        ok: false,
        err: fail('jws', `payload hostname "${payload.hostname}" does not match request hostname`),
      };
    }
    return { ok: true, payload };
  } catch (err) {
    if (err instanceof JwsError) {
      return { ok: false, err: fail('jws', err.message) };
    }
    return { ok: false, err: fail('jws', `unexpected error: ${(err as Error).message}`) };
  }
}

function runFreshnessStage(
  issuedAt: string,
  maxBundleAge: number | undefined,
  now: Date | undefined,
): StageResult<Record<never, never>> {
  if (typeof maxBundleAge !== 'number') return { ok: true };
  const issued = Date.parse(issuedAt);
  if (!Number.isFinite(issued)) {
    return { ok: false, err: fail('jws', `payload.issuedAt "${issuedAt}" is not a parseable timestamp`) };
  }
  const age = (now ?? new Date()).getTime() - issued;
  if (age > maxBundleAge) {
    return { ok: false, err: fail('jws', `bundle age ${age}ms exceeds maxBundleAge=${maxBundleAge}ms`) };
  }
  if (age < -ALLOWED_CLOCK_SKEW_MS) {
    return { ok: false, err: fail('jws', `payload.issuedAt is ${-age}ms in the future, beyond allowed skew`) };
  }
  return { ok: true };
}

async function runTlsFingerprintStage(
  payloadFingerprint: string,
  observedFingerprint: string | undefined,
  tlsLeafPem: string | undefined,
): Promise<StageResult<{ channelBinding: ChannelBinding }>> {
  // Live channel binding is preferred whenever the caller can produce it — it is the
  // only mode the gatekeeper uses. Producer-asserted binding is the fallback for
  // environments without channel access.
  if (observedFingerprint !== undefined) {
    if (!fingerprintsEqual(payloadFingerprint, observedFingerprint)) {
      return {
        ok: false,
        err: fail(
          'tls-fingerprint',
          `payload certFingerprint ${payloadFingerprint} does not match observed ${observedFingerprint}`,
        ),
      };
    }
    return { ok: true, channelBinding: 'observed' };
  }

  if (tlsLeafPem !== undefined) {
    let derivedFingerprint: string;
    try {
      const cert = new X509Certificate(tlsLeafPem);
      derivedFingerprint = await sha256Fingerprint(new Uint8Array(cert.rawData));
    } catch (err) {
      return {
        ok: false,
        err: fail('tls-fingerprint', `failed to parse bundle.tlsLeaf: ${(err as Error).message}`),
      };
    }
    if (!fingerprintsEqual(payloadFingerprint, derivedFingerprint)) {
      return {
        ok: false,
        err: fail(
          'tls-fingerprint',
          `payload certFingerprint ${payloadFingerprint} does not match bundle.tlsLeaf fingerprint ${derivedFingerprint}`,
        ),
      };
    }
    return { ok: true, channelBinding: 'producer-asserted' };
  }

  return {
    ok: false,
    err: fail('tls-fingerprint', 'no observed fingerprint and no tlsLeaf in bundle'),
  };
}
