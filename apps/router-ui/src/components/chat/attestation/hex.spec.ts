import { describe, expect, it } from 'vitest';
import { abbreviate, fingerprintHex, prefixedHex } from './hex';

/**
 * The browser's half of the SUP-115 convention. It has to agree with
 * `router-api`'s `fingerprintHex` byte for byte, so the vector below is one the
 * server-side parser's own fixtures carry: the `evidenceDigest` /
 * `evidenceDigestHex` pair of `test-fixtures.ts`, which came out of the shared
 * `vectors/evidence-digest.json`.
 */
const CANONICAL = 'sha256/9Xk2fT1pQvA7BdE4rL0eQm3XkTpZ8vNc1YsWuHgJoAs';
const HEX = 'f579367d3d6942f03b05d138acbd1e426dd7913a59f2f35cd58b16b87809a00b';

describe('fingerprintHex', () => {
  it('spells a canonical fingerprint the way the console shows it', () => {
    expect(fingerprintHex(CANONICAL)).toBe(HEX);
    expect(prefixedHex(CANONICAL)).toBe(`sha256:${HEX}`);
  });

  it('accepts the padding some producers emit', () => {
    expect(fingerprintHex(`${CANONICAL}=`)).toBe(HEX);
  });

  it('returns null — not an empty string — for anything that is not a 32-byte digest', () => {
    // A row with no value and a row with a value it could not read are different
    // things, and the panel says them differently.
    expect(fingerprintHex(null)).toBeNull();
    expect(fingerprintHex('')).toBeNull();
    expect(fingerprintHex('sha256/short')).toBeNull();
    expect(fingerprintHex(HEX)).toBeNull();
    expect(fingerprintHex('sha512/9Xk2fT1pQvA7BdE4rL0eQm3XkTpZ8vNc1YsWuHgJoAs')).toBeNull();
  });
});

describe('abbreviate', () => {
  it('keeps both ends, because that is how a digest is compared by eye', () => {
    expect(abbreviate(HEX)).toBe('f579367d3d…b87809a00b');
  });

  it('leaves a value short enough to read in full alone', () => {
    expect(abbreviate('deadbeef')).toBe('deadbeef');
  });
});
