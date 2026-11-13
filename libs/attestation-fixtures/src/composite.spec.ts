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

  it('keeps the two EAT profiles different in claim mapping and signing key', () => {
    const [first, second] = manifest.appraisers.filter((a) => a.kind === 'eat');
    expect(first, 'two EAT profiles are needed to show the swap is configuration').toBeDefined();
    expect(second).toBeDefined();
    if (!first || !second) return;

    // A second profile that reused the first one's spelling and key would
    // demonstrate nothing: it would be the same decoder running twice.
    expect(second.verificationKey?.pem).not.toBe(first.verificationKey?.pem);
    expect(second.issuer).not.toBe(first.issuer);
    expect(second.claimMapping?.encoding).not.toBe(first.claimMapping?.encoding);

    const registers = ['tdattributes', 'mrtd', 'rtmr0', 'rtmr1', 'rtmr2', 'rtmr3'] as const;
    for (const register of registers) {
      const a = first.claimMapping?.[register];
      const b = second.claimMapping?.[register];
      expect(a, `the first profile does not map ${register}`).toBeDefined();
      expect(b, `the second profile does not map ${register}`).toBeDefined();
      // Every register is mapped on both, and nowhere the same: the image
      // identity is computed from all six, and a mapping missing one would
      // derive an identity from a register nothing checked.
      expect(a, `the two profiles share the ${register} claim path`).not.toEqual(b);
    }
  });

  it('names no profile after a real Verifier', () => {
    // The tokens are this repository's invention. A profile carrying a
    // vendor's name would publish claim names that vendor does not emit —
    // which is how `tdx_tdattributes` and `attester_held_data`-as-report-data
    // were once published under Intel's name (SUP-648, SUP-699).
    const vendors = ['ita', 'intel', 'trustauthority', 'trust-authority', 'veraison', 'azure', 'maa'];
    for (const profile of manifest.appraisers) {
      const subject = `${profile.name} ${profile.issuer ?? ''}`.toLowerCase();
      for (const vendor of vendors) {
        expect(subject, `${profile.name} is named after a real Verifier`).not.toContain(vendor);
      }
    }
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

  it('overrides a profile only where the delegated path legitimately differs', () => {
    // An absent override is the acceptance this corpus exists for: the claim
    // set may not depend on which appraiser produced it. The two shapes an
    // override may take are a typed coverage denial, and a sound appraisal
    // that says in `note` why this profile reaches another answer.
    for (const testCase of manifest.cases) {
      for (const [profile, override] of Object.entries(testCase.expect.appraisers ?? {})) {
        const where = `${testCase.id} / ${profile}`;
        if (!override.ok) {
          expect(override.stage, `${where}: a denial override is only ever about coverage`).toBe('coverage');
          continue;
        }
        expect(override.note, `${where}: a sound override says nothing about why it differs`).toBeTruthy();
      }
    }
  });

  it('records a token per EAT profile against the quote it appraises, or states the coverage limit', () => {
    for (const testCase of manifest.cases) {
      const appraisal = loadCompositeAppraisal(testCase);
      const platform = appraisal.quote.platform;
      for (const profile of manifest.appraisers.filter((a) => a.kind === 'eat')) {
        const recorded = appraisal.eat?.[profile.name];
        expect(recorded, `${testCase.id}: nothing recorded for ${profile.name}`).toBeDefined();
        const tokens = Object.entries(recorded?.tokens ?? {});

        if (tokens.length === 0) {
          // No token means this profile does not cover the quote's platform:
          // the delegated path denies before it asks a Verifier anything, so
          // the profile has to say what it answers instead.
          expect(
            profile.outsideCoverage,
            `${profile.name} records nothing and declares no coverage limit`,
          ).toBeDefined();
          expect(platform, `${testCase.id}: no platform recorded to be outside a coverage`).toBeDefined();
          expect(profile.platforms ?? [], `${profile.name} covers ${platform} and recorded nothing`).not.toContain(
            platform,
          );
          continue;
        }
        for (const [evidenceDigest, token] of tokens) {
          // Keyed by the digest of the evidence it appraises: a token that
          // sat beside a case rather than being about its quote would still
          // pass a corpus that keyed by position.
          expect(evidenceDigest).toMatch(/^[0-9a-f]{64}$/);
          expect(token.split('.')).toHaveLength(3);
        }
      }
    }
  });

  it('keeps the image identity out of every token', () => {
    // A quote-only Verifier does not know it: mrEnclave is derived from the
    // RTMR0 event list it never consumed. A corpus whose tokens carried the
    // finished answer could not be replayed through the production delegated
    // appraiser at all (SUP-699).
    for (const testCase of manifest.cases) {
      const appraisal = loadCompositeAppraisal(testCase);
      for (const recorded of Object.values(appraisal.eat ?? {})) {
        for (const token of Object.values(recorded.tokens)) {
          const payload = token.split('.')[1] ?? '';
          const claims = Buffer.from(payload, 'base64url').toString('utf8');
          for (const absent of ['mrenclave', 'spvm_build', 'approved', 'identity']) {
            expect(claims, `${testCase.id}: a token carries ${absent}`).not.toContain(absent);
          }
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
