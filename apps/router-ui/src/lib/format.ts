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

/**
 * Parses a user-typed dollar amount into the integer micro-USD string the API
 * takes. Returns null for anything that is not a plain amount with at most six
 * decimals — the caller turns that into a field error.
 *
 * Deliberately string arithmetic: `12.34 * 1_000_000` is 12339999.999999998.
 */
export function usdToMicros(value: string): string | null {
  const trimmed = value.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(trimmed)) return null;
  const [whole, fraction = ''] = trimmed.split('.');
  return (BigInt(whole) * MICROS_PER_USD + BigInt(fraction.padEnd(6, '0'))).toString();
}

/** The inverse, for pre-filling an edit form: `1500000` → `1.5`. */
export function microsToUsdInput(micros: string): string {
  return String(microsToUsd(micros));
}

const BYTE_UNITS = ['B', 'kB', 'MB', 'GB'];

/** Download sizes. `0` means the release did not say, and renders as a dash. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < BYTE_UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${BYTE_UNITS[unit]}`;
}

/**
 * One date shape for the console. UTC, because every timestamp the API returns
 * is UTC and a table that silently shifted them would misreport an expiry.
 */
export function formatDate(iso: string | null | undefined, fallback = '—'): string {
  if (!iso) return fallback;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return fallback;
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}
