import { loadTrustedRoots } from '@confidential-router/attestation-fixtures';
import { describe, expect, it } from 'vitest';
import { rootFingerprintFromPem } from '../cert-chain.js';
import { base64UrlEncode, fingerprintsEqual, isFingerprint, sha256Fingerprint } from '../fingerprint.js';

describe('isFingerprint', () => {
  it.each([
    ['sha256/AAAA', true],
    ['sha256/abc-_123', true],
    ['sha256/', false],
    ['sha1/AAAA', false],
    ['sha256/has+plus', false],
    ['sha256/has/slash', false],
    ['AAAA', false],
  ])('%s -> %s', (value, expected) => {
    expect(isFingerprint(value)).toBe(expected);
  });

  it('rejects non-strings', () => {
    expect(isFingerprint(undefined)).toBe(false);
    expect(isFingerprint(42)).toBe(false);
  });
});

describe('base64UrlEncode', () => {
  it('emits the unpadded URL alphabet', () => {
    const bytes = new Uint8Array([0xfb, 0xff, 0xfe, 0x00]);
    expect(base64UrlEncode(bytes)).toBe(Buffer.from(bytes).toString('base64url'));
    expect(base64UrlEncode(bytes)).not.toContain('=');
  });

  it('accepts an ArrayBuffer as well as a view', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(base64UrlEncode(bytes.buffer)).toBe(base64UrlEncode(bytes));
  });
});

describe('sha256Fingerprint', () => {
  it('reproduces the fingerprints recorded in the fixture trust store', async () => {
    for (const root of loadTrustedRoots()) {
      expect(await rootFingerprintFromPem(root.pem)).toBe(root.fingerprint);
    }
  });

  it('is stable and canonical for a known input', async () => {
    const digest = await sha256Fingerprint(new TextEncoder().encode('confidential-router'));
    expect(digest).toMatch(/^sha256\/[A-Za-z0-9_-]{43}$/);
    expect(await sha256Fingerprint(new TextEncoder().encode('confidential-router'))).toBe(digest);
  });
});

describe('fingerprintsEqual', () => {
  it('compares by value and rejects length mismatches', () => {
    expect(fingerprintsEqual('sha256/abc', 'sha256/abc')).toBe(true);
    expect(fingerprintsEqual('sha256/abc', 'sha256/abd')).toBe(false);
    expect(fingerprintsEqual('sha256/abc', 'sha256/abcd')).toBe(false);
  });
});
