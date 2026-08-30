/**
 * The conformance suite: every vector in `@confidential-router/attestation-fixtures`
 * is replayed through `verifyHostname`. The Go verifier in
 * `apps/gatekeeper/pkg/attestation` is held to the same vectors, so a change here
 * that is not a change to the fixtures means the two implementations have drifted.
 */
import {
  type ConformanceCase,
  loadConformanceManifest,
  loadTrustedRoots,
  makeCaseFetcher,
  resolveTrustedRoots,
} from '@confidential-router/attestation-fixtures';
import { describe, expect, it } from 'vitest';
import type { TrustedRoot, VerifyParams, VerifyResult } from '../types.js';
import { verifyHostname } from '../verify.js';

const manifest = loadConformanceManifest();
const roots = loadTrustedRoots();

function paramsFor(testCase: ConformanceCase): VerifyParams {
  const trustedRoots: TrustedRoot[] = resolveTrustedRoots(testCase.request.trustedRoots, roots).map((r) => ({
    name: r.name,
    pem: r.pem,
  }));
  return {
    hostname: testCase.request.hostname,
    trustedRoots,
    observedTlsFingerprint: testCase.request.observedTlsFingerprint,
    maxBundleAge: testCase.request.maxBundleAge,
    now: new Date(testCase.request.now),
    fetcher: makeCaseFetcher(testCase),
  };
}

function describeResult(result: VerifyResult): string {
  return result.ok ? 'ok' : `${result.stage}: ${result.reason}`;
}

describe(`conformance vectors (manifest v${manifest.version})`, () => {
  it('is not empty', () => {
    expect(manifest.cases.length).toBeGreaterThan(0);
  });

  for (const testCase of manifest.cases) {
    it(`${testCase.id} — ${testCase.description}`, async () => {
      const result = await verifyHostname(paramsFor(testCase));
      const { expect: expected } = testCase;

      expect(result.ok, describeResult(result)).toBe(expected.ok);
      if (!expected.ok) {
        if (result.ok) throw new Error('unreachable');
        expect(result.stage).toBe(expected.stage);
        expect(result.reason).toContain(expected.reasonContains);
        return;
      }
      if (!result.ok) throw new Error('unreachable');
      expect(result.kind).toBe(expected.kind);
      expect(result.channelBinding).toBe(expected.channelBinding);
      expect(result.matchedRoot.name).toBe(expected.matchedRoot);
      expect(result.matchedRoot.fingerprint).toBe(roots.find((r) => r.name === expected.matchedRoot)?.fingerprint);
      expect(result.payload).toEqual(expected.payload);
      expect(result.rootCaTeeQuote).toEqual(expected.rootCaTeeQuote);
    });
  }
});
