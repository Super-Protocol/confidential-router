/**
 * `evidenceDigest` is the value a Gatekeeper user pins per endpoint: the SHA-256
 * of the canonical deployment snapshot published at
 * `https://<host>/.well-known/swarm-evidence`.
 *
 * The canonical wire form is `sha256/<base64url>` (unpadded). Bare lowercase or
 * uppercase hex is accepted on input — humans copy it out of logs — and is
 * normalised to the canonical form before it is compared or stored.
 */

export const EVIDENCE_DIGEST_PREFIX = 'sha256/';

export type EvidenceDigest = `sha256/${string}`;

/** 32 bytes base64url-encoded, padding optional. */
const BASE64URL_SHA256 = /^[A-Za-z0-9_-]{43}=?$/;

const HEX_SHA256 = /^[0-9a-fA-F]{64}$/;

export class InvalidEvidenceDigestError extends Error {
  constructor(readonly value: string) {
    super(`Not a valid evidence digest: ${JSON.stringify(value)}`);
    this.name = 'InvalidEvidenceDigestError';
  }
}

export function isEvidenceDigest(value: string): value is EvidenceDigest {
  return value.startsWith(EVIDENCE_DIGEST_PREFIX) && BASE64URL_SHA256.test(value.slice(EVIDENCE_DIGEST_PREFIX.length));
}

/**
 * Accepts `sha256/<base64url>` or bare hex and returns the canonical
 * `sha256/<base64url>` form. Throws {@link InvalidEvidenceDigestError} on
 * anything else — callers pinning trust must never silently accept junk.
 */
export function normalizeEvidenceDigest(value: string): EvidenceDigest {
  const trimmed = value.trim();

  if (isEvidenceDigest(trimmed)) {
    const encoded = trimmed.slice(EVIDENCE_DIGEST_PREFIX.length).replace(/=+$/, '');
    return `${EVIDENCE_DIGEST_PREFIX}${encoded}`;
  }

  const hex = trimmed.startsWith(EVIDENCE_DIGEST_PREFIX) ? trimmed.slice(EVIDENCE_DIGEST_PREFIX.length) : trimmed;
  if (HEX_SHA256.test(hex)) {
    return `${EVIDENCE_DIGEST_PREFIX}${hexToBase64Url(hex.toLowerCase())}`;
  }

  throw new InvalidEvidenceDigestError(value);
}

/** Constant-time-ish equality on the canonical form; both sides are normalised first. */
export function evidenceDigestEquals(a: string, b: string): boolean {
  return normalizeEvidenceDigest(a) === normalizeEvidenceDigest(b);
}

function hexToBase64Url(hex: string): string {
  let binary = '';
  for (let i = 0; i < hex.length; i += 2) {
    binary += String.fromCharCode(Number.parseInt(hex.slice(i, i + 2), 16));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
