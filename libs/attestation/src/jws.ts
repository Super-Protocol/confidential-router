/**
 * Compact-JWS verification against the chain leaf's public key.
 *
 * Ported from Super-Protocol/swarm-cloud `libs/swarm-attestation/src/jws.ts`
 * (BSL-1.1) with permission; see the repository NOTICE.
 */
import type { X509Certificate } from '@peculiar/x509';
import { compactVerify, decodeProtectedHeader } from 'jose';
import { isSecp256k1Cert, verifySecp256k1 } from './crypto-secp256k1.js';
import type { EvidenceKind, EvidencePayload } from './types.js';

export class JwsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JwsError';
  }
}

export type SupportedJwsAlg = 'RS256' | 'ES256K';
const SUPPORTED_ALGS: ReadonlySet<SupportedJwsAlg> = new Set<SupportedJwsAlg>(['RS256', 'ES256K']);

const KIND_VALUES = new Set<EvidenceKind>([
  'DeploymentEvidence',
  'ControlPlaneEvidence',
  'KubernetesControlPlaneEvidence',
]);

export async function verifyJws(jws: string, leaf: X509Certificate): Promise<EvidencePayload> {
  let header: { alg?: unknown };
  try {
    header = decodeProtectedHeader(jws) as { alg?: unknown };
  } catch (err) {
    throw new JwsError(`failed to decode JWS protected header: ${(err as Error).message}`);
  }
  const alg = typeof header.alg === 'string' ? header.alg : '<missing>';
  if (!SUPPORTED_ALGS.has(alg as SupportedJwsAlg)) {
    throw new JwsError(`unsupported JWS alg "${alg}" (expected RS256 or ES256K)`);
  }

  const plaintext = alg === 'RS256' ? await verifyJwsRs256(jws, leaf) : await verifyJwsEs256k(jws, leaf);

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(plaintext));
  } catch (err) {
    throw new JwsError(`failed to parse JWS payload as JSON: ${(err as Error).message}`);
  }
  if (!isEvidencePayload(parsed)) {
    throw new JwsError('JWS payload is not a recognised evidence payload');
  }
  return parsed;
}

async function verifyJwsRs256(jws: string, leaf: X509Certificate): Promise<Uint8Array> {
  let publicKey: CryptoKey;
  try {
    publicKey = (await leaf.publicKey.export()) as CryptoKey;
  } catch (err) {
    throw new JwsError(`failed to export leaf public key: ${(err as Error).message}`);
  }
  try {
    const result = await compactVerify(jws, publicKey, { algorithms: ['RS256'] });
    return result.payload;
  } catch (err) {
    throw new JwsError(`signature verification failed: ${(err as Error).message}`);
  }
}

async function verifyJwsEs256k(jws: string, leaf: X509Certificate): Promise<Uint8Array> {
  if (!isSecp256k1Cert(leaf)) {
    throw new JwsError('JWS alg is ES256K but leaf certificate key is not secp256k1');
  }

  // ES256K is verified with the bundled pure-JS implementation on every runtime — see
  // the note on `verifyChildAgainstParent` in cert-chain.ts. Web Crypto's K-256 support
  // is inconsistent enough that "try subtle, fall back on failure" cannot distinguish an
  // unsupported curve from a bad signature.
  const segments = jws.split('.');
  if (segments.length !== 3) {
    throw new JwsError('compact JWS must have exactly 3 segments');
  }
  const [headerB64, payloadB64, signatureB64] = segments as [string, string, string];

  let signatureBytes: Uint8Array;
  let payloadBytes: Uint8Array;
  try {
    signatureBytes = base64UrlDecode(signatureB64);
    payloadBytes = base64UrlDecode(payloadB64);
  } catch (err) {
    throw new JwsError(`failed to decode JWS segment: ${(err as Error).message}`);
  }

  const signedBytes = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  let ok: boolean;
  try {
    ok = verifySecp256k1(signatureBytes, signedBytes, new Uint8Array(leaf.publicKey.rawData));
  } catch (err) {
    throw new JwsError(`secp256k1 fallback verification raised: ${(err as Error).message}`);
  }
  if (!ok) {
    throw new JwsError('ES256K signature verification failed');
  }
  return payloadBytes;
}

function base64UrlDecode(s: string): Uint8Array {
  const padded = s
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(s.length + ((4 - (s.length % 4)) % 4), '=');
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function isEvidencePayload(value: unknown): value is EvidencePayload {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.version !== '1') return false;
  if (typeof v.kind !== 'string' || !KIND_VALUES.has(v.kind as EvidenceKind)) return false;
  if (typeof v.hostname !== 'string' || v.hostname.length === 0) return false;
  if (typeof v.issuedAt !== 'string' || v.issuedAt.length === 0) return false;
  if (typeof v.certFingerprint !== 'string' || !v.certFingerprint.startsWith('sha256/')) {
    return false;
  }
  return true;
}
