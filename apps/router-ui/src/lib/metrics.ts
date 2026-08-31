/**
 * The units Activity and Logs render that are neither money nor a plain count:
 * token volumes, latencies, throughput and coverage ratios.
 *
 * `format.ts` keeps money and digests, which every screen needs; these are the
 * metering units, and they live apart so a change to one cannot surprise the
 * other.
 */

const COMPACT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const EXACT = new Intl.NumberFormat('en-US');

/** `598M`, `11K`, `842`. Used wherever a token or request count is a headline. */
export function formatCount(value: number): string {
  return value < 1000 ? EXACT.format(value) : COMPACT.format(value);
}

/** Exact, grouped — for a table cell, where the number is read not scanned. */
export function formatExact(value: number): string {
  return EXACT.format(value);
}

/**
 * `312 ms` under a second, `1.4 s` above it. Null renders as an em dash: a
 * missing time-to-first-token means the request never reported one (it was not
 * streamed, or it failed), which is not the same as zero.
 */
export function formatMs(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(value < 10_000 ? 2 : 1)} s`;
}

/** `48.2 tok/s`, or an em dash when the generation reported no throughput. */
export function formatTokensPerSecond(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `${value.toFixed(1)} tok/s`;
}

/**
 * A 0–1 ratio as a percentage. Rounded to a whole number above 99.5% only when
 * it really is 100% — "100%" printed for 0.999 would claim every response was
 * covered when one was not.
 */
export function formatRatio(ratio: number): string {
  if (ratio >= 1) return '100%';
  if (ratio > 0 && ratio < 0.01) return '<1%';
  const rounded = Math.floor(ratio * 1000) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}%`;
}
