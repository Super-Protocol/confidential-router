import { loadCaseBody, loadConformanceManifest } from '@confidential-router/attestation-fixtures';
import { describe, expect, it } from 'vitest';
import { EvidenceBundleError, parseEvidenceBundle } from './evidence-bundle.js';

/**
 * The bundles are the conformance fixtures the verifiers are held to, used here
 * for the opposite purpose: to prove the router reads a published bundle without
 * verifying it. Several of these fixtures are ones the *verifier* rejects — a
 * bad signature, an untrusted root — and the parser must still file them, because
 * whether they are any good is the user's gatekeeper's question (ADR-002).
 */
const manifest = loadConformanceManifest();

function bundle(id: string): Record<string, unknown> {
  const testCase = manifest.cases.find((c) => c.id === id);
  if (!testCase) throw new Error(`unknown conformance case "${id}"`);
  return loadCaseBody(testCase) as Record<string, unknown>;
}

/** Re-encodes a bundle's JWS with a patched payload. Signatures are never checked here. */
function withPayload(raw: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const [header, payload, signature] = (raw.jws as string).split('.');
  const decoded = JSON.parse(Buffer.from(payload as string, 'base64url').toString('utf8'));
  const encoded = Buffer.from(JSON.stringify({ ...decoded, ...patch }), 'utf8').toString('base64url');
  return { ...raw, jws: [header, encoded, signature].join('.') };
}

describe('parseEvidenceBundle', () => {
  it('reads everything a snapshot keeps out of an RS256 bundle', () => {
    const parsed = parseEvidenceBundle(bundle('valid-rsa-deployment'), 'router.example.test');

    expect(parsed.digest.canonical).toBe('sha256/weMdyCn3VNUosV0Mxf6P1D8iWGXVyTZ_d-5vEW4Q9qs');
    expect(parsed.digest.hex).toHaveLength(64);
    expect(parsed.certFingerprint).toMatch(/^sha256\/[A-Za-z0-9_-]{43}$/);
    expect(parsed.issuedAt.toISOString()).toBe('2026-01-15T11:55:00.000Z');
    expect(parsed.quoteFormat).toBe('intel-tdx-quote-v5');
    expect(parsed.jws).toBe((bundle('valid-rsa-deployment') as { jws: string }).jws);
  });

  it('flattens the enclave image digests out of the canonical snapshot', () => {
    const parsed = parseEvidenceBundle(bundle('valid-rsa-deployment'), 'router.example.test');

    expect(parsed.containerImages).toEqual([
      'ghcr.io/super-protocol/router-api@sha256:1111111111111111111111111111111111111111111111111111111111111111',
      'ghcr.io/berriai/litellm@sha256:2222222222222222222222222222222222222222222222222222222222222222',
    ]);
  });

  it('summarises the chain leaf → root without validating it', () => {
    const parsed = parseEvidenceBundle(bundle('valid-rsa-deployment'), 'router.example.test');

    expect(parsed.chainSummary.length).toBeGreaterThan(1);
    expect(parsed.chainSummary[0]?.subject).toContain('router.example.test');
    for (const certificate of parsed.chainSummary) {
      expect(certificate.fingerprint).toMatch(/^sha256\/[A-Za-z0-9_-]{43}$/);
      expect(Number.isNaN(Date.parse(certificate.notAfter))).toBe(false);
    }
  });

  it('reads an ES256K bundle the same way', () => {
    const parsed = parseEvidenceBundle(bundle('valid-ec-deployment'), 'router.example.test');

    expect(parsed.digest.canonical).toMatch(/^sha256\//);
  });

  it('files a bundle whose signature the verifier rejects — that is not this parser’s question', () => {
    const parsed = parseEvidenceBundle(bundle('jws-bad-signature'), 'router.example.test');

    expect(parsed.digest.canonical).toMatch(/^sha256\//);
  });

  it('files a bundle that chains to an untrusted root, for the same reason', () => {
    const parsed = parseEvidenceBundle(bundle('untrusted-root-other-cloud'), 'router.example.test');

    expect(parsed.chainSummary.length).toBeGreaterThan(0);
  });

  it('keeps a stale bundle: staleness is a state the console renders, not a parse error', () => {
    const parsed = parseEvidenceBundle(bundle('jws-stale-bundle'), 'router.example.test');

    expect(parsed.issuedAt.getTime()).toBeLessThan(Date.parse(manifest.referenceNow));
  });

  it('has no measurements when the producer published none', () => {
    expect(parseEvidenceBundle(bundle('valid-rsa-deployment'), 'router.example.test').measurements).toBeNull();
  });

  it('keeps measurement registers when it did', () => {
    const raw = withPayload(bundle('valid-rsa-deployment'), {
      evidence: { version: 2, resources: [], measurements: { MRTD: '91f4a2', RTMR0: 'c3a71e' } },
    });

    expect(parseEvidenceBundle(raw, 'router.example.test').measurements).toEqual({ MRTD: '91f4a2', RTMR0: 'c3a71e' });
  });

  it('normalises a hex evidenceDigest to the canonical form users pin', () => {
    const hex = 'c1e31dc829f754d528b15d0cc5fe8fd43f225865d5c9367f77ee6f116e10f6ab';
    const raw = withPayload(bundle('valid-rsa-deployment'), { evidenceDigest: hex });

    expect(parseEvidenceBundle(raw, 'router.example.test').digest).toEqual({
      canonical: 'sha256/weMdyCn3VNUosV0Mxf6P1D8iWGXVyTZ_d-5vEW4Q9qs',
      hex,
    });
  });

  describe('refuses to file', () => {
    it('a bundle published for a different hostname', () => {
      expect(() => parseEvidenceBundle(bundle('valid-rsa-deployment'), 'other.example.test')).toThrow(
        EvidenceBundleError,
      );
    });

    it('a JWS payload naming a different hostname than the envelope', () => {
      expect(() => parseEvidenceBundle(bundle('jws-payload-hostname-mismatch'), 'router.example.test')).toThrow(
        /payload hostname/,
      );
    });

    it('a kind that is not DeploymentEvidence', () => {
      expect(() => parseEvidenceBundle(bundle('valid-rsa-control-plane'), 'router.example.test')).toThrow(
        /unsupported bundle kind/,
      );
    });

    it('an unparseable evidenceDigest', () => {
      const raw = withPayload(bundle('valid-rsa-deployment'), { evidenceDigest: 'sha512/nope' });

      expect(() => parseEvidenceBundle(raw, 'router.example.test')).toThrow(EvidenceBundleError);
    });

    it('a payload with no evidenceDigest at all', () => {
      const raw = bundle('valid-rsa-deployment');
      const [header, payload, signature] = (raw.jws as string).split('.');
      const decoded = JSON.parse(Buffer.from(payload as string, 'base64url').toString('utf8'));
      delete decoded.evidenceDigest;
      const stripped = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url');

      expect(() =>
        parseEvidenceBundle({ ...raw, jws: [header, stripped, signature].join('.') }, 'router.example.test'),
      ).toThrow(/DeploymentEvidence payload/);
    });

    it('a document that is not a bundle at all', () => {
      expect(() => parseEvidenceBundle({ hello: 'world' }, 'router.example.test')).toThrow(/swarm-evidence v1 shape/);
      expect(() => parseEvidenceBundle('not json object', 'router.example.test')).toThrow(EvidenceBundleError);
    });

    it('a certChain member that is not a certificate', () => {
      const raw = {
        ...bundle('valid-rsa-deployment'),
        certChain: ['-----BEGIN CERTIFICATE-----\nnope\n-----END CERTIFICATE-----'],
      };

      expect(() => parseEvidenceBundle(raw, 'router.example.test')).toThrow(/certChain\[0\]/);
    });
  });
});
