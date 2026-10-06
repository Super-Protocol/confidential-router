/**
 * The canonical form of a trust-list entry (ADR-008 §3).
 *
 * The admin list is a *set*, and a set only works if two spellings of one value
 * are one value. `schemas/gatekeeper-config.schema.json` accepts a `sha256:` or
 * `0x` prefix and either case for `attestedRoots.trustedMeasurements`, "because
 * that is how one gets pasted" — so the same three spellings arrive here, from a
 * registry page, a `gatekeeper` log line and a vendor's console. Storing them as
 * written would let an operator add the same cloud three times and remove it
 * once, which is a fail-open hole in a list whose removal is the kill switch.
 *
 * Normalising at the API boundary rather than at render time is deliberate: the
 * unique index on `trusted_measurements.measurement` is what makes a duplicate a
 * conflict instead of a silent second row, and an index cannot normalise.
 *
 * Pure, with no Nest and no database, so the spec can enumerate the spellings.
 */

/** Bare lower-case hex — what the registry names a measurement by and what the CLI writes. */
const CANONICAL = /^[0-9a-f]{64}$/;

/** The prefixes a paste carries, stripped before the hex is judged. */
const PREFIX = /^(sha256:|0x)/i;

export class InvalidMeasurementError extends Error {
  constructor(value: string) {
    // The value is echoed because it is not a secret — it is a public image
    // measurement, and an operator who mistyped one character needs to see which.
    super(
      `"${value}" is not a VM launch measurement: expected 64 hex characters, optionally prefixed with ` +
        '`sha256:` or `0x`.',
    );
    this.name = 'InvalidMeasurementError';
  }
}

/**
 * Normalises one measurement, or refuses it.
 *
 * @throws InvalidMeasurementError when it is not 64 hex characters once the
 *   optional prefix is gone.
 */
export function normaliseMeasurement(value: string): string {
  const normalised = value.trim().replace(PREFIX, '').toLowerCase();
  if (!CANONICAL.test(normalised)) {
    throw new InvalidMeasurementError(value.trim());
  }
  return normalised;
}
