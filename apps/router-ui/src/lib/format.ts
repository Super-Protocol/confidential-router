/**
 * Formatting helpers for the console's two recurring number shapes: money, which
 * the API sends as integer micro-USD strings (`Micros`), and large counts.
 */

const MICROS_PER_USD = 1_000_000n;

/**
 * `Micros` is a *string* of integer micro-USD. It is parsed as a bigint, not a
 * number, because a busy workspace's lifetime spend can exceed the range where
 * a double still represents every micro exactly.
 */
export function microsToUsd(micros: string): number {
  const value = BigInt(micros);
  const whole = value / MICROS_PER_USD;
  const fraction = value % MICROS_PER_USD;
  return Number(whole) + Number(fraction) / 1_000_000;
}

export function formatUsd(micros: string, options: Intl.NumberFormatOptions = {}): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    ...options,
  }).format(microsToUsd(micros));
}

export function formatCompact(value: number): string {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

/** Truncates a `sha256/<base64url>` digest for display, keeping both ends. */
export function shortenDigest(digest: string, keep = 6): string {
  const [algorithm, encoded] = digest.includes('/') ? digest.split('/', 2) : ['', digest];
  if (!encoded || encoded.length <= keep * 2 + 1) return digest;
  const short = `${encoded.slice(0, keep)}…${encoded.slice(-keep)}`;
  return algorithm ? `${algorithm}/${short}` : short;
}
