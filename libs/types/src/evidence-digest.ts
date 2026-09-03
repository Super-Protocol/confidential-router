/**
 * `evidenceDigest` is the value a Gatekeeper user pins per endpoint: the SHA-256
 * of the canonical deployment snapshot published at
 * `https://<host>/.well-known/swarm-evidence`.
 *
 * The canonical wire form is `sha256/<base64url>` (unpadded). Bare lowercase or
 * uppercase hex is accepted on input — humans copy it out of logs — and is
 * normalised to the canonical form before it is compared or stored.
 *
 * What a human *sees* is the other spelling: `sha256:<hex>`, produced by
 * {@link formatEvidenceDigestHex}. It is what the gatekeeper CLI and dashboard
 * print, what a gatekeeper config file records, and what the router console
 * shows and copies, so that one deployment reads as one string everywhere
 * (SUP-115). Only the canonical form goes on the wire; only the hex form goes
 * to a reader.
 */

export const EVIDENCE_DIGEST_PREFIX = 'sha256/';

/** The scheme of the human-facing spelling. */
export const EVIDENCE_DIGEST_HEX_PREFIX = 'sha256:';

export type EvidenceDigest = `sha256/${string}`;

/**
 * 32 bytes base64url-encoded, padding optional.
 *
 * 43 base64url characters carry 258 bits, so the final character must have its two
 * trailing bits clear — only `A E I M Q U Y c g k o s w 0 4 8` can end a 32-byte
 * digest. Accepting the other 48 characters would admit up to four distinct
 * spellings of the same bytes, and pins are compared as exact strings.
 */
const BASE64URL_SHA256 = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]=?$/;

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
 * Accepts `sha256/<base64url>`, `sha256/<hex>`, `sha256:<hex>` or bare hex and
 * returns the canonical `sha256/<base64url>` form. Throws
 * {@link InvalidEvidenceDigestError} on anything else — callers pinning trust
 * must never silently accept junk.
 *
 * `sha256:<hex>` is here because it is the form everything user-facing prints:
 * whatever a user copies off a screen has to be a value this reads back.
 */
export function normalizeEvidenceDigest(value: string): EvidenceDigest {
  const trimmed = value.trim();

  if (isEvidenceDigest(trimmed)) {
    const encoded = trimmed.slice(EVIDENCE_DIGEST_PREFIX.length).replace(/=+$/, '');
    return `${EVIDENCE_DIGEST_PREFIX}${encoded}`;
  }

  const hex = stripScheme(trimmed);
  if (HEX_SHA256.test(hex)) {
    return `${EVIDENCE_DIGEST_PREFIX}${hexToBase64Url(hex.toLowerCase())}`;
  }

  throw new InvalidEvidenceDigestError(value);
}

/**
 * Any accepted spelling as the human-facing `sha256:<hex>` one.
 *
 * Throws on a value that is not a digest: a caller formatting one for display is
 * holding a digest, and a screen that renders junk as if it were a fingerprint
 * is worse than one that reports the problem.
 */
export function formatEvidenceDigestHex(value: string): string {
  return `${EVIDENCE_DIGEST_HEX_PREFIX}${evidenceDigestHex(value)}`;
}

/** The 64 lower-case hex characters of a digest, without a scheme. */
export function evidenceDigestHex(value: string): string {
  const canonical = normalizeEvidenceDigest(value);
  return base64UrlToHex(canonical.slice(EVIDENCE_DIGEST_PREFIX.length));
}

function stripScheme(value: string): string {
  if (value.startsWith(EVIDENCE_DIGEST_PREFIX)) return value.slice(EVIDENCE_DIGEST_PREFIX.length);
  if (value.startsWith(EVIDENCE_DIGEST_HEX_PREFIX)) return value.slice(EVIDENCE_DIGEST_HEX_PREFIX.length);
  return value;
}

/** Equality on the canonical form; both sides are normalised first. */
export function evidenceDigestEquals(a: string, b: string): boolean {
  return normalizeEvidenceDigest(a) === normalizeEvidenceDigest(b);
}

function base64UrlToHex(encoded: string): string {
  const binary = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'));
  let hex = '';
  for (let i = 0; i < binary.length; i++) {
    hex += binary.charCodeAt(i).toString(16).padStart(2, '0');
  }
  return hex;
}

function hexToBase64Url(hex: string): string {
  let binary = '';
  for (let i = 0; i < hex.length; i += 2) {
    binary += String.fromCharCode(Number.parseInt(hex.slice(i, i + 2), 16));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
