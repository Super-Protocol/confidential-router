/**
 * The one `evidenceDigest` parser on the TypeScript side.
 *
 * `evidenceDigest` is the value a user pins in their gatekeeper (ADR-002 §3), so
 * every surface that shows or stores one has to agree on what a digest *is*.
 * Canonical form is `sha256/<base64url>` of 32 bytes; hex is accepted on input
 * and normalised. The accepted and rejected encodings are not invented here —
 * they are the language-neutral vectors in
 * `@confidential-router/attestation-fixtures` (`vectors/evidence-digest.json`),
 * which the Go parser in `apps/gatekeeper/pkg/attestation` is held to as well
 * (SUP-87). `evidence-digest.spec.ts` runs this parser over every one of them.
 */

const CANONICAL_BODY = /^[A-Za-z0-9_-]{43}$/;
const HEX_BODY = /^[0-9a-fA-F]{64}$/;
const PREFIX = 'sha256/';

export class EvidenceDigestError extends Error {
  constructor(input: string, reason: string) {
    super(`Invalid evidenceDigest "${input}": ${reason}.`);
    this.name = 'EvidenceDigestError';
  }
}

/** Both encodings of one digest; the console shows the hex, the gatekeeper pins the canonical. */
export interface EvidenceDigest {
  /** `sha256/<base64url>`, unpadded. */
  canonical: string;
  /** Lowercase, 64 characters, no prefix. */
  hex: string;
}

/**
 * Parses any accepted encoding into both canonical forms, or throws.
 *
 * Deliberately strict about what it will *not* normalise: a bare base64url body
 * without the `sha256/` prefix is rejected, because a 43-character string with
 * no algorithm label is not self-describing and pinning one would silently bind
 * a user to whatever hash the producer happened to use.
 */
export function parseEvidenceDigest(input: unknown): EvidenceDigest {
  if (typeof input !== 'string') {
    throw new EvidenceDigestError(String(input), 'expected a string');
  }
  const trimmed = input.trim();
  const prefixed = trimmed.startsWith(PREFIX);
  const body = prefixed ? trimmed.slice(PREFIX.length) : trimmed;

  if (HEX_BODY.test(body)) {
    const hex = body.toLowerCase();
    return { canonical: `${PREFIX}${base64UrlOfHex(hex)}`, hex };
  }
  if (!prefixed) {
    throw new EvidenceDigestError(trimmed, 'expected "sha256/<base64url>" or 64 hex characters');
  }

  // A 32-byte base64url body is 43 characters plus one padding character;
  // producers differ on whether they emit it, so accept and drop it.
  const unpadded = body.replace(/=+$/, '');
  if (!CANONICAL_BODY.test(unpadded)) {
    throw new EvidenceDigestError(trimmed, 'base64url body must be 43 characters from the URL-safe alphabet');
  }
  const bytes = Buffer.from(unpadded, 'base64url');
  // Round-trip rather than a character-class check on the final character: it
  // rejects the same non-canonical trailing bits and cannot drift from the
  // encoder.
  if (bytes.length !== 32 || bytes.toString('base64url') !== unpadded) {
    throw new EvidenceDigestError(trimmed, 'body does not decode to a canonical 32-byte digest');
  }
  return { canonical: `${PREFIX}${unpadded}`, hex: bytes.toString('hex') };
}

function base64UrlOfHex(hex: string): string {
  return Buffer.from(hex, 'hex').toString('base64url');
}
