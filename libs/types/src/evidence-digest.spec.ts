import { describe, expect, it } from 'vitest';
import {
  EVIDENCE_DIGEST_PREFIX,
  evidenceDigestEquals,
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

  it('rejects anything that is not a 32-byte digest', () => {
    for (const bad of ['', 'sha256/', 'sha256/short', 'deadbeef', `${EVIDENCE_DIGEST_PREFIX}${BASE64URL}extra`]) {
      expect(() => normalizeEvidenceDigest(bad)).toThrow(InvalidEvidenceDigestError);
    }
  });
});
