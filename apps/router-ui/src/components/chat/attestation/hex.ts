/**
 * `sha256:<hex>` — the spelling every user-facing surface of this product uses
 * for a digest or a fingerprint (SUP-115).
 *
 * The bundle carries `sha256/<base64url>`, because that is what the contract
 * fixes and what the two verifiers compare. A reader comparing a value with
 * Gatekeeper's output, with `docker inspect`, or with a colleague's screenshot is
 * comparing hex — so the panel renders hex and keeps the canonical form beside it
 * rather than making the reader convert.
 *
 * `router-api` answers the same question with `fingerprintHex`
 * (`app/evidence/evidence-digest.ts`), which is deliberately not imported here:
 * that module is Node-only — it decodes with `Buffer` — and this one runs in the
 * browser over a bundle the page fetched itself, which is the whole point of
 * tier 1. The two have to agree, and the one thing they are allowed to disagree
 * about is how they get the bytes.
 */

const CANONICAL = /^sha256\/([A-Za-z0-9_-]+)={0,2}$/;

/**
 * The hex spelling of a `sha256/<base64url>` fingerprint, or null when the value
 * is not one.
 *
 * Null rather than an empty string: the panel's job is to say what it knows, and
 * a row that quietly shows nothing is indistinguishable from a row whose value is
 * genuinely absent.
 */
export function fingerprintHex(fingerprint: string | null | undefined): string | null {
  if (!fingerprint) return null;
  const match = CANONICAL.exec(fingerprint.trim());
  if (!match?.[1]) return null;

  const base64 = match[1].replace(/-/g, '+').replace(/_/g, '/');
  let binary: string;
  try {
    binary = atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '='));
  } catch {
    return null;
  }
  if (binary.length !== 32) return null;

  let hex = '';
  for (let index = 0; index < binary.length; index += 1) {
    hex += binary.charCodeAt(index).toString(16).padStart(2, '0');
  }
  return hex;
}

/** `sha256:<hex>`, the form a reader pastes into a gatekeeper config. */
export function prefixedHex(fingerprint: string | null | undefined): string | null {
  const hex = fingerprintHex(fingerprint);
  return hex ? `sha256:${hex}` : null;
}

/**
 * A long hex value shortened for a label, with the full value always available
 * elsewhere on the row.
 *
 * Head and tail rather than a truncation: a reader comparing two digests by eye
 * checks both ends, and a value cut off at one end can be made to collide at the
 * other.
 */
export function abbreviate(value: string, keep = 10): string {
  return value.length <= keep * 2 + 1 ? value : `${value.slice(0, keep)}…${value.slice(-keep)}`;
}
