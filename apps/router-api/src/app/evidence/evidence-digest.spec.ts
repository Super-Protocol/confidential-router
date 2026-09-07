import { loadEvidenceDigestVectors } from '@confidential-router/attestation-fixtures';
import { describe, expect, it } from 'vitest';
import { EvidenceDigestError, fingerprintHex, parseEvidenceDigest } from './evidence-digest.js';

/**
 * The vectors are the contract, shared with the Go parser in
 * `apps/gatekeeper/pkg/attestation` (SUP-87). A digest this parser normalises
 * differently from that one would let a user pin a value in the console that
 * their gatekeeper then refuses.
 */
const { cases } = loadEvidenceDigestVectors();

describe('parseEvidenceDigest, against the shared vectors', () => {
  for (const testCase of cases.filter((c) => c.valid)) {
    it(`accepts ${testCase.note ?? testCase.input}`, () => {
      expect(parseEvidenceDigest(testCase.input).canonical).toBe(testCase.canonical);
    });
  }

  for (const testCase of cases.filter((c) => !c.valid)) {
    it(`rejects ${testCase.note ?? JSON.stringify(testCase.input)}`, () => {
      expect(() => parseEvidenceDigest(testCase.input)).toThrow(EvidenceDigestError);
    });
  }

  it('covers both encodings of the same digest', () => {
    const digest = parseEvidenceDigest('sha256/weMdyCn3VNUosV0Mxf6P1D8iWGXVyTZ_d-5vEW4Q9qs');

    expect(digest.hex).toBe('c1e31dc829f754d528b15d0cc5fe8fd43f225865d5c9367f77ee6f116e10f6ab');
    expect(parseEvidenceDigest(digest.hex).canonical).toBe(digest.canonical);
  });

  it('reads back the sha256:<hex> form every user-facing surface prints', () => {
    const canonical = 'sha256/weMdyCn3VNUosV0Mxf6P1D8iWGXVyTZ_d-5vEW4Q9qs';
    const shown = `sha256:${parseEvidenceDigest(canonical).hex}`;

    expect(parseEvidenceDigest(shown).canonical).toBe(canonical);
  });

  it('renders a fingerprint in hex for the console, and nothing for a value it cannot read', () => {
    expect(fingerprintHex('sha256/weMdyCn3VNUosV0Mxf6P1D8iWGXVyTZ_d-5vEW4Q9qs')).toBe(
      'c1e31dc829f754d528b15d0cc5fe8fd43f225865d5c9367f77ee6f116e10f6ab',
    );
    // The console falls back to the canonical spelling it is sent alongside.
    expect(fingerprintHex('not-a-fingerprint')).toBe('');
  });

  it('rejects a non-string', () => {
    expect(() => parseEvidenceDigest(undefined)).toThrow(EvidenceDigestError);
    expect(() => parseEvidenceDigest(42)).toThrow(EvidenceDigestError);
  });
});
