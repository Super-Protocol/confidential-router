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
/** The scheme of the human-facing spelling — what the console shows and the gatekeeper prints. */
const HEX_PREFIX = 'sha256:';

export class EvidenceDigestError extends Error {
  constructor(input: string, reason: string) {
    super(`Invalid evidenceDigest "${input}": ${reason}.`);
    this.name = 'EvidenceDigestError';
  }
}

/** Both encodings of one digest; the console shows the hex, the bundle carries the canonical. */
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
  // `sha256:<hex>` is the form every user-facing surface prints (SUP-115), so
  // it has to be a form this reads back.
  const body = prefixed ? trimmed.slice(PREFIX.length) : stripHexPrefix(trimmed);

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

/**
 * The hex spelling of a fingerprint, for the fields the console renders as
 * `sha256:<hex>`.
 *
 * Returns an empty string for a value that is not a 32-byte digest. Every
 * fingerprint stored on an `EvidenceSnapshot` passed the bundle's shape check
 * on the way in, so this is a guard rather than a path — but a GraphQL query
 * for a whole overview should not fail because one historical row holds
 * something odd; the console falls back to the canonical form it also receives.
 */
export function fingerprintHex(value: string): string {
  try {
    return parseEvidenceDigest(value).hex;
  } catch {
    return '';
  }
}

function stripHexPrefix(value: string): string {
  return value.startsWith(HEX_PREFIX) ? value.slice(HEX_PREFIX.length) : value;
}

function base64UrlOfHex(hex: string): string {
  return Buffer.from(hex, 'hex').toString('base64url');
}
