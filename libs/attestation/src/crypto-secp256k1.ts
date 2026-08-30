/**
 * Pure-JS secp256k1 (K-256) verification fallback for environments whose
 * `crypto.subtle` does not expose the curve.
 *
 * Ported from Super-Protocol/swarm-cloud
 * `libs/swarm-attestation/src/crypto-secp256k1.ts` (BSL-1.1) with permission;
 * see the repository NOTICE.
 */
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha2';
import type { X509Certificate } from '@peculiar/x509';

// secp256k1 SubjectPublicKeyInfo BIT STRING wrapper:
//   03 42 00 04 [32-byte X] [32-byte Y]
// (BIT STRING tag, 66-byte length, zero unused-bits, uncompressed point indicator).
const SPKI_BIT_STRING_TAG = 0x03;
const SPKI_BIT_STRING_LEN = 0x42;
const SPKI_UNUSED_BITS = 0x00;
const UNCOMPRESSED_POINT_TAG = 0x04;
const UNCOMPRESSED_POINT_LEN = 65;

export function extractSecp256k1PublicPoint(spkiDer: Uint8Array): Uint8Array {
  for (let i = 0; i + 4 + UNCOMPRESSED_POINT_LEN <= spkiDer.length + 1; i++) {
    if (
      spkiDer[i] === SPKI_BIT_STRING_TAG &&
      spkiDer[i + 1] === SPKI_BIT_STRING_LEN &&
      spkiDer[i + 2] === SPKI_UNUSED_BITS &&
      spkiDer[i + 3] === UNCOMPRESSED_POINT_TAG
    ) {
      return spkiDer.slice(i + 3, i + 3 + UNCOMPRESSED_POINT_LEN);
    }
  }
  throw new Error('SPKI does not contain an uncompressed secp256k1 public point');
}

export function isSecp256k1Cert(cert: X509Certificate): boolean {
  const algo = cert.publicKey.algorithm as { name?: string; namedCurve?: string };
  return algo.name === 'ECDSA' && algo.namedCurve === 'K-256';
}

/**
 * Verifies a secp256k1 signature using the noble fallback. `signatureBytes` may be
 * either the JWS compact form (64 bytes raw r||s) or the X.509 DER-encoded SEQUENCE.
 */
export function verifySecp256k1(signatureBytes: Uint8Array, signedBytes: Uint8Array, spkiDer: Uint8Array): boolean {
  const publicPoint = extractSecp256k1PublicPoint(spkiDer);
  const messageHash = sha256(signedBytes);
  const format = signatureBytes.length === 64 ? 'compact' : 'der';

  // `prehash: false` (the default) means `messageHash` is consumed as-is rather than
  // hashed again.
  return secp256k1.verify(signatureBytes, messageHash, publicPoint, { format });
}

/**
 * Extracts the TBSCertificate DER bytes (the data covered by the certificate
 * signature) from the full X.509 certificate DER. `@peculiar/x509` exposes the
 * parsed TBS structure but not the raw bytes via the public API, so we walk the
 * outer SEQUENCE manually.
 */
export function extractTbsCertificate(certDer: Uint8Array): Uint8Array {
  if (certDer[0] !== 0x30) {
    throw new Error('certificate DER does not start with a SEQUENCE tag');
  }
  const outer = readDerLength(certDer, 1);
  const tbsStart = 1 + outer.headerLen;
  if (certDer[tbsStart] !== 0x30) {
    throw new Error('TBSCertificate is not a SEQUENCE');
  }
  const tbs = readDerLength(certDer, tbsStart + 1);
  const tbsEnd = tbsStart + 1 + tbs.headerLen + tbs.length;
  if (tbsEnd > certDer.length) {
    throw new Error('TBSCertificate extends beyond certificate bounds');
  }
  return certDer.slice(tbsStart, tbsEnd);
}

function readDerLength(buf: Uint8Array, offset: number): { length: number; headerLen: number } {
  const first = buf[offset];
  if (first === undefined) {
    throw new Error('truncated DER length');
  }
  if (first < 0x80) {
    return { length: first, headerLen: 1 };
  }
  const numBytes = first & 0x7f;
  if (numBytes === 0 || numBytes > 4) {
    throw new Error(`unsupported DER length form (${numBytes} bytes)`);
  }
  let length = 0;
  for (let i = 0; i < numBytes; i++) {
    const b = buf[offset + 1 + i];
    if (b === undefined) {
      throw new Error('truncated DER length');
    }
    length = (length << 8) | b;
  }
  return { length, headerLen: 1 + numBytes };
}
