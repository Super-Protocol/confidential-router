import { describe, expect, it } from 'vitest';
import {
  type CompositeCase,
  loadCompositeAppraisal,
  loadCompositeEvidence,
  loadCompositeManifest,
  loadCompositeTrustedRoots,
  loadConformanceManifest,
  loadRootQuoteAppraisal,
  resolveTrustedRoots,
} from './index.js';

const manifest = loadCompositeManifest();
const roots = loadCompositeTrustedRoots();
const cases = manifest.cases.map((c) => [c.id, c] as const);

/**
 * These are structural checks, not an appraisal: TypeScript has no composite
 * verifier yet, and the Go harness in `libs/swarm-evidence-go/conformance` is
 * what replays the corpus. What is worth checking from here is that the
 * corpus is loadable and self-consistent from a second language — a vector
 * file only Go can read would stop being a language-neutral contract the day
 * the TypeScript appraiser is written.
 */
describe('composite manifest', () => {
  it('has a unique id per case and declares the appraiser profiles', () => {
    const ids = manifest.cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);

    const names = manifest.appraisers.map((a) => a.name);
    expect(new Set(names).size).toBe(names.length);
    expect(manifest.appraisers.filter((a) => a.kind === 'eat').length).toBeGreaterThanOrEqual(2);
  });

  it('keeps the two EAT profiles different in claim names and signing key', () => {
    const [first, second] = manifest.appraisers.filter((a) => a.kind === 'eat');
    expect(first, 'two EAT profiles are needed to show the swap is configuration').toBeDefined();
    expect(second).toBeDefined();
    if (!first || !second) return;

    // A second profile that reused the first one's spelling and key would
    // demonstrate nothing: it would be the same decoder running twice.
    expect(second.verificationKey?.pem).not.toBe(first.verificationKey?.pem);
    expect(second.issuer).not.toBe(first.issuer);
    expect(second.octetEncoding).not.toBe(first.octetEncoding);
    const shared = Object.keys(first.claimNames ?? {}).filter(
      (field) => first.claimNames?.[field] === second.claimNames?.[field],
    );
    expect(shared, 'the two profiles share claim names').toEqual([]);
  });

  it('covers every platform and every denial stage the claim set can report', () => {
    const platforms = new Set(manifest.cases.map((c) => loadCompositeAppraisal(c).quote.platform).filter(Boolean));
    expect([...platforms].sort()).toEqual(['snp-azure', 'snp-qemu', 'tdx-azure', 'tdx-gcp', 'tdx-qemu']);

    const stages = new Set(manifest.cases.flatMap((c) => (c.expect.ok ? [] : [c.expect.stage])));
    expect([...stages].sort()).toEqual(['binding', 'envelope', 'pki-chain', 'root-quote', 'statement']);
  });

  it.each(cases)('%s resolves its referenced files', (_id, testCase: CompositeCase) => {
    expect(resolveTrustedRoots(testCase.request.trustedRoots, roots)).toHaveLength(
      testCase.request.trustedRoots.length,
    );
    expect(testCase.request.freshnessInput).toMatch(/^[0-9a-f]+$/);
    expect(loadCompositeEvidence(testCase)).toBeTypeOf('object');
    expect(loadCompositeAppraisal(testCase).quote).toBeTypeOf('object');
  });

  it.each(cases)('%s pins a whole claim set', (_id, testCase: CompositeCase) => {
    const expectations = [testCase.expect, ...Object.values(testCase.expect.appraisers ?? {})];
    for (const expectation of expectations) {
      expect(expectation.claims.schema_version).toBe('1');
      expect(expectation.claims.freshness_input).toBe(testCase.request.freshnessInput);

      if (expectation.ok) {
        // A sound appraisal names what appraised the quote, and the name is
        // resolved per profile rather than pinned.
        expect(expectation.claims.quote_appraiser).toBe('<appraiser>');
        expect(expectation.claims.denial).toBeUndefined();
        continue;
      }
      // A refusal is never a partial pass: the denial, the schema version and
      // the freshness input the appraisal was asked to bind, and nothing else.
      expect(expectation.claims.denial).toEqual({ stage: expectation.stage });
      expect(Object.keys(expectation.claims).sort()).toEqual(['denial', 'freshness_input', 'schema_version']);
    }
  });

  it('records a token per EAT profile, or states the coverage limit', () => {
    for (const testCase of manifest.cases) {
      const appraisal = loadCompositeAppraisal(testCase);
      for (const profile of manifest.appraisers.filter((a) => a.kind === 'eat')) {
        const tokens = appraisal.eat?.[profile.name];
        expect(tokens, `${testCase.id}: no tokens recorded for ${profile.name}`).toBeDefined();
        if (!tokens) continue;

        for (const [half, token] of Object.entries(tokens)) {
          if (token === '') {
            // No result recorded means this profile does not cover that
            // half's platform, and it must say what it answers instead.
            expect(profile.outsideCoverage, `${profile.name} covers no ${half} and declares nothing`).toBeDefined();
            continue;
          }
          expect(token.split('.')).toHaveLength(3);
        }
      }
    }
  });
});

describe('claims expectations of the bundle corpus', () => {
  const bundle = loadConformanceManifest();

  it('carries one for every case, against a recorded root-quote appraisal', () => {
    const recorded = loadRootQuoteAppraisal();
    expect(recorded.appraisal.platform).toBeDefined();
    expect(recorded.appraiser).not.toBe('');

    for (const testCase of bundle.cases) {
      const claims = testCase.expect.claims;
      expect(claims, `${testCase.id} carries no claims expectation`).toBeDefined();
      expect(claims.document.schema_version).toBe('1');
      if (claims.ok) {
        expect(claims.document.denial).toBeUndefined();
        // The bundle form is about a served hostname: it establishes a
        // channel binding and no request binding.
        expect(claims.document.channel_binding).toBeDefined();
        expect(claims.document.binding_ok).toBeUndefined();
      } else {
        expect(claims.document.denial).toEqual({ stage: claims.stage });
      }
    }
  });
});
