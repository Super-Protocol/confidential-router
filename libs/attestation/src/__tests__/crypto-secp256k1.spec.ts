/**
 * The pure-JS secp256k1 path. Node's WebCrypto does not expose K-256, so the fixture
 * EC chain already exercises this fallback end to end in `conformance.spec.ts`; these
 * cases pin the DER walking it depends on.
 */
import { loadTrustedRoots } from '@confidential-router/attestation-fixtures';
import { secp256k1 } from '@noble/curves/secp256k1';
import { X509Certificate } from '@peculiar/x509';
import { describe, expect, it } from 'vitest';
import {
  extractSecp256k1PublicPoint,
  extractTbsCertificate,
  isSecp256k1Cert,
  verifySecp256k1,
} from '../crypto-secp256k1.js';

const roots = loadTrustedRoots();
const rootPem = (name: string): string =>
  roots.find((r) => r.name === name)?.pem ??
  (() => {
    throw new Error(`missing ${name} fixture`);
  })();

const ecRoot = new X509Certificate(rootPem('confidential-router-test-root-ec'));
const ecRootHighS = new X509Certificate(rootPem('confidential-router-test-root-ec-high-s'));
const rsaRoot = new X509Certificate(rootPem('confidential-router-test-root-rsa'));

describe('isSecp256k1Cert', () => {
  it('distinguishes a K-256 certificate from an RSA one', () => {
    expect(isSecp256k1Cert(ecRoot)).toBe(true);
    expect(isSecp256k1Cert(rsaRoot)).toBe(false);
  });
});

describe('extractSecp256k1PublicPoint', () => {
  it('returns the 65-byte uncompressed point of a K-256 SPKI', () => {
    const point = extractSecp256k1PublicPoint(new Uint8Array(ecRoot.publicKey.rawData));
    expect(point).toHaveLength(65);
    expect(point[0]).toBe(0x04);
  });

  it('throws when the SPKI holds no uncompressed point', () => {
    expect(() => extractSecp256k1PublicPoint(new Uint8Array(rsaRoot.publicKey.rawData))).toThrow(
      /uncompressed secp256k1 public point/,
    );
  });
});

describe('extractTbsCertificate', () => {
  it('returns the exact bytes the root self-signature covers', () => {
    const der = new Uint8Array(ecRoot.rawData);
    const tbs = extractTbsCertificate(der);

    expect(tbs[0]).toBe(0x30);
    expect(tbs.length).toBeLessThan(der.length);
    expect(verifySecp256k1(new Uint8Array(ecRoot.signature), tbs, new Uint8Array(ecRoot.publicKey.rawData))).toBe(true);
  });

  it('rejects a payload that is not a certificate SEQUENCE', () => {
    expect(() => extractTbsCertificate(new Uint8Array([0x02, 0x01, 0x00]))).toThrow(/SEQUENCE tag/);
  });
});

describe('verifySecp256k1', () => {
  // noble's `secp256k1` object is built with `lowS: true`, so `verify` rejects the high
  // half of S by default. Neither RFC 7515 nor X.509 asks for that, and the Go verifier
  // accepts both halves — see README, "Deviations from the source". The assertion on S
  // itself is what keeps a future regeneration from quietly turning the fixture low-S
  // and leaving the acceptance test tautological.
  it('accepts a high-S certificate signature', () => {
    const signature = new Uint8Array(ecRootHighS.signature);
    expect(derSignatureS(signature)).toBeGreaterThan(secp256k1.Point.Fn.ORDER >> 1n);

    const tbs = extractTbsCertificate(new Uint8Array(ecRootHighS.rawData));
    expect(verifySecp256k1(signature, tbs, new Uint8Array(ecRootHighS.publicKey.rawData))).toBe(true);
  });

  it('rejects a tampered TBS', () => {
    const tbs = extractTbsCertificate(new Uint8Array(ecRoot.rawData));
    const tampered = Uint8Array.from(tbs);
    tampered[tampered.length - 1] ^= 0xff;

    expect(verifySecp256k1(new Uint8Array(ecRoot.signature), tampered, new Uint8Array(ecRoot.publicKey.rawData))).toBe(
      false,
    );
  });
});

/** Reads the S component out of a DER-encoded ECDSA signature (SEQUENCE { r, s }). */
function derSignatureS(der: Uint8Array): bigint {
  const first = der[1] as number;
  const contentStart = first < 0x80 ? 2 : 2 + (first & 0x7f);
  const rLength = der[contentStart + 1] as number;
  const sStart = contentStart + 2 + rLength;
  const sLength = der[sStart + 1] as number;
  return der.slice(sStart + 2, sStart + 2 + sLength).reduce((acc, byte) => (acc << 8n) | BigInt(byte), 0n);
}
