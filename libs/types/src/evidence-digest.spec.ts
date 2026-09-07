import { loadEvidenceDigestVectors } from '@confidential-router/attestation-fixtures';
import { describe, expect, it } from 'vitest';
import {
  EVIDENCE_DIGEST_HEX_PREFIX,
  EVIDENCE_DIGEST_PREFIX,
  evidenceDigestEquals,
  formatEvidenceDigestHex,
  InvalidEvidenceDigestError,
  isEvidenceDigest,
  normalizeEvidenceDigest,
} from './evidence-digest.js';

// An arbitrary 32-byte digest and its canonical base64url spelling.
const HEX = 'c0ffee11c0ffee22c0ffee33c0ffee44c0ffee55c0ffee66c0ffee77c0ffee88';
const BASE64URL = 'wP_uEcD_7iLA_-4zwP_uRMD_7lXA_-5mwP_ud8D_7og';

describe('evidence digest', () => {
  it('recognises the canonical sha256/<base64url> form', () => {
    expect(isEvidenceDigest(`${EVIDENCE_DIGEST_PREFIX}${BASE64URL}`)).toBe(true);
    expect(isEvidenceDigest(HEX)).toBe(false);
  });

  it('normalises hex input to the canonical form', () => {
    expect(normalizeEvidenceDigest(HEX)).toBe(`${EVIDENCE_DIGEST_PREFIX}${BASE64URL}`);
    expect(normalizeEvidenceDigest(HEX.toUpperCase())).toBe(`${EVIDENCE_DIGEST_PREFIX}${BASE64URL}`);
    expect(normalizeEvidenceDigest(`${EVIDENCE_DIGEST_PREFIX}${HEX}`)).toBe(`${EVIDENCE_DIGEST_PREFIX}${BASE64URL}`);
  });

  it('strips padding and surrounding whitespace', () => {
    expect(normalizeEvidenceDigest(`  ${EVIDENCE_DIGEST_PREFIX}${BASE64URL}=  `)).toBe(
      `${EVIDENCE_DIGEST_PREFIX}${BASE64URL}`,
    );
  });

  it('treats hex and base64url spellings of the same digest as equal', () => {
    expect(evidenceDigestEquals(HEX, `${EVIDENCE_DIGEST_PREFIX}${BASE64URL}`)).toBe(true);
  });

  it('rejects standard-base64 spelling — only base64url is canonical', () => {
    const standardBase64 = BASE64URL.replace(/-/g, '+').replace(/_/g, '/');

    expect(isEvidenceDigest(`${EVIDENCE_DIGEST_PREFIX}${standardBase64}`)).toBe(false);
    expect(() => normalizeEvidenceDigest(`${EVIDENCE_DIGEST_PREFIX}${standardBase64}`)).toThrow(
      InvalidEvidenceDigestError,
    );
  });

  it('is idempotent — normalising a canonical digest returns it unchanged', () => {
    const canonical = normalizeEvidenceDigest(HEX);

    expect(normalizeEvidenceDigest(canonical)).toBe(canonical);
  });

  it('accepts the printed sha256:<hex> form back', () => {
    expect(normalizeEvidenceDigest(`${EVIDENCE_DIGEST_HEX_PREFIX}${HEX}`)).toBe(
      `${EVIDENCE_DIGEST_PREFIX}${BASE64URL}`,
    );
  });

  it('renders any spelling as the human-facing sha256:<hex> one', () => {
    for (const input of [HEX, HEX.toUpperCase(), `${EVIDENCE_DIGEST_PREFIX}${BASE64URL}`]) {
      expect(formatEvidenceDigestHex(input)).toBe(`${EVIDENCE_DIGEST_HEX_PREFIX}${HEX}`);
    }
  });

  it('refuses to render something that is not a digest', () => {
    expect(() => formatEvidenceDigestHex('not-a-digest')).toThrow(InvalidEvidenceDigestError);
  });

  it('rejects anything that is not a 32-byte digest', () => {
    for (const bad of ['', 'sha256/', 'sha256/short', 'deadbeef', `${EVIDENCE_DIGEST_PREFIX}${BASE64URL}extra`]) {
      expect(() => normalizeEvidenceDigest(bad)).toThrow(InvalidEvidenceDigestError);
    }
  });
});

/**
 * The same vectors the Go pin loader in `apps/gatekeeper/pkg/config` is held to, so
 * both implementations accept and reject exactly the same spellings.
 */
describe('evidence digest conformance vectors', () => {
  const vectors = loadEvidenceDigestVectors();

  it.each(vectors.cases.map((c) => [`${c.valid ? 'accepts' : 'rejects'} ${c.note}`, c] as const))(
    '%s',
    (_label, testCase) => {
      if (testCase.valid) {
        expect(normalizeEvidenceDigest(testCase.input)).toBe(testCase.canonical);
      } else {
        expect(() => normalizeEvidenceDigest(testCase.input)).toThrow(InvalidEvidenceDigestError);
      }
    },
  );

  /**
   * The display half of the same contract, asserted here exactly as the Go side
   * asserts it over these vectors (`TestConformanceDisplayFormIsTheHexSpelling`
   * in `apps/gatekeeper/pkg/trust`): the console and the gatekeeper show one
   * string for one deployment, and that string is itself accepted input.
   */
  it.each(vectors.cases.filter((c) => c.valid).map((c) => [c.note, c] as const))(
    'renders and reads back the hex form of %s',
    (_note, testCase) => {
      const shown = formatEvidenceDigestHex(testCase.input);

      expect(shown).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(normalizeEvidenceDigest(shown)).toBe(testCase.canonical);
    },
  );
});
