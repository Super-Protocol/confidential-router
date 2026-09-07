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

/**
 * Prices are micro-USD per 1M tokens and are routinely well under a cent, so
 * two decimals would round most of the catalogue to `$0.00`. Four is enough for
 * every price the router config can express, and trailing zeroes are dropped so
 * `$0.28` does not read as `$0.2800`.
 */
export function formatPricePer1m(micros: string): string {
  return formatUsd(micros, { maximumFractionDigits: 4 });
}

/** `0.984` → `98.4%`; a whole percentage loses its `.0`. */
export function formatPercent(ratio: number): string {
  return new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 }).format(ratio);
}

/** Context windows are quoted in K/M of tokens, never as 128000. */
export function formatContextLength(tokens: number): string {
  if (tokens >= 1_000_000) return `${trimZero(tokens / 1_000_000)}M`;
  if (tokens >= 1000) return `${trimZero(tokens / 1000)}K`;
  return String(tokens);
}

function trimZero(value: number): string {
  return value.toFixed(1).replace(/\.0$/, '');
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * `EvidenceSnapshot.quoteAgeSeconds` as "issued 4 min ago".
 *
 * Seconds are kept below a minute because a quote's age is the one number in
 * the evidence modal a viewer watches change while re-fetching.
 */
export function formatQuoteAge(seconds: number): string {
  const age = Math.max(0, Math.round(seconds));
  if (age < MINUTE) return `${age}s ago`;
  if (age < HOUR) return `${Math.floor(age / MINUTE)} min ago`;
  if (age < DAY) return `${Math.floor(age / HOUR)} h ago`;
  return `${Math.floor(age / DAY)} d ago`;
}

const TIMESTAMP_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'UTC',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/**
 * An ISO instant as `2026-08-31 09:30 UTC` — `formatDate` below when the day is
 * enough, this when the time of day matters.
 *
 * Always UTC, never the browser's zone: evidence timestamps are compared
 * against `issuedAt` values a viewer reads out of a bundle or a gatekeeper log,
 * and both of those are UTC. It also keeps a server-rendered string identical
 * to the one the browser produces, which a locale-dependent format does not.
 */
export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${TIMESTAMP_FORMAT.format(date).replace(',', '')} UTC`;
}

/** The scheme every digest this console shows carries. */
const DIGEST_HEX_PREFIX = 'sha256:';

/**
 * The one spelling of a digest the whole product shows: `sha256:<hex>`.
 *
 * Hex is what the browser extension, the gatekeeper CLI and its dashboard all
 * print, and what a gatekeeper config file records, so a digest copied here is
 * a digest that can be pasted into `gatekeeper endpoint trust add` and read
 * back off a verification report unchanged (SUP-115). The API sends both
 * spellings of every fingerprint; the canonical `sha256/<base64url>` one is the
 * fallback for the rare row whose hex form the server could not derive.
 */
export function formatDigest(hex: string, canonical: string): string {
  return hex ? `${DIGEST_HEX_PREFIX}${hex}` : canonical;
}

/** Truncates a digest for display, keeping its scheme and both ends. */
export function shortenDigest(digest: string, keep = 6): string {
  const separator = digest.search(/[:/]/);
  const [algorithm, encoded] =
    separator < 0 ? ['', digest] : [digest.slice(0, separator + 1), digest.slice(separator + 1)];
  if (!encoded || encoded.length <= keep * 2 + 1) return digest;
  return `${algorithm}${encoded.slice(0, keep)}…${encoded.slice(-keep)}`;
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
