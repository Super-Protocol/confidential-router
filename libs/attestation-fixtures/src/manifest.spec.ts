import { describe, expect, it } from 'vitest';
import {
  loadCaseBody,
  loadConformanceManifest,
  loadEvidenceDigestVectors,
  loadTrustedRoots,
  resolveTrustedRoots,
} from './index.js';

const manifest = loadConformanceManifest();
const roots = loadTrustedRoots();

describe('conformance manifest', () => {
  it('has a unique id per case', () => {
    const ids = manifest.cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('covers every verifier stage and every evidence kind', () => {
    const stages = new Set(manifest.cases.flatMap((c) => (c.expect.ok ? [] : [c.expect.stage])));
    expect([...stages].sort()).toEqual(['cert-chain', 'fetch', 'jws', 'tls-fingerprint', 'untrusted-root']);

    const kinds = new Set(manifest.cases.flatMap((c) => (c.expect.ok ? [c.expect.kind] : [])));
    expect([...kinds].sort()).toEqual(['ControlPlaneEvidence', 'DeploymentEvidence', 'KubernetesControlPlaneEvidence']);

    const bindings = new Set(manifest.cases.flatMap((c) => (c.expect.ok ? [c.expect.channelBinding] : [])));
    expect([...bindings].sort()).toEqual(['observed', 'producer-asserted']);
  });

  it.each(manifest.cases.map((c) => [c.id, c] as const))('%s resolves its referenced files', (_id, testCase) => {
    expect(resolveTrustedRoots(testCase.request.trustedRoots, roots)).toHaveLength(
      testCase.request.trustedRoots.length,
    );
    const hasBodyFile = testCase.response.bodyFile !== undefined;
    expect(hasBodyFile || testCase.response.bodyText !== undefined).toBe(true);
    if (hasBodyFile) {
      expect(loadCaseBody(testCase)).toBeTypeOf('object');
    }
  });
});

describe('roots.json', () => {
  it('exposes distinct, PEM-encoded anchors with canonical fingerprints', () => {
    expect(roots.length).toBeGreaterThan(1);
    expect(new Set(roots.map((r) => r.fingerprint)).size).toBe(roots.length);
    for (const root of roots) {
      expect(root.name).toMatch(/^[a-z0-9][a-z0-9-]{0,62}$/);
      expect(root.fingerprint).toMatch(/^sha256\/[A-Za-z0-9_-]{43}$/);
      expect(root.pem).toMatch(/^-----BEGIN CERTIFICATE-----/);
    }
  });
});

describe('evidence-digest.json', () => {
  const vectors = loadEvidenceDigestVectors();

  it('pairs every accepted input with its canonical form and every rejected one without', () => {
    expect(vectors.cases.length).toBeGreaterThan(10);
    for (const c of vectors.cases) {
      if (c.valid) {
        expect(c.canonical, c.input).toMatch(/^sha256\/[A-Za-z0-9_-]{43}$/);
      } else {
        expect(c.canonical, c.input).toBeUndefined();
      }
    }
  });

  it('documents the canonical trailing characters it rejects outside of', () => {
    expect(vectors.canonicalFinalCharacters).toBe('AEIMQUYcgkosw048');
    for (const c of vectors.cases) {
      if (!c.canonical) continue;
      expect(vectors.canonicalFinalCharacters).toContain(c.canonical.slice(-1));
    }
  });
});
