/**
 * The pure shaping behind the Profile screen's two charts.
 *
 * Everything here works in UTC. `activitySeries` buckets start on UTC
 * boundaries and `signedResponseDays` returns UTC days, so a local-time day
 * would put a generation in the wrong square for anyone west of Greenwich. The
 * date window itself is `lib/date-range`, shared with Overview and Activity.
 */
import type { BarDatum } from '@confidential-router/ui/components/charts/bar-chart';
import type { HeatmapCell } from '@confidential-router/ui/components/charts/heatmap';
import { formatBucketLabel } from '../../lib/date-range';

const DAY_MS = 24 * 60 * 60 * 1000;

/** How many days the spend chart covers. */
export const SPEND_DAYS = 7;

/**
 * How many days the signed-response heatmap covers — 26 columns of 7, which is
 * the widest contribution graph that stays legible in the card.
 */
export const HEATMAP_DAYS = 182;

/** `YYYY-MM-DD` of an instant, in UTC. */
export function utcDay(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString().slice(0, 10);
}

export interface SpendPoint {
  bucket: string;
  spendMicros: string;
}

/** Daily spend as chart bars, labelled the way Overview labels its buckets. */
export function spendBars(points: readonly SpendPoint[]): BarDatum[] {
  return points.map((point) => ({
    label: formatBucketLabel(point.bucket),
    // Dollars, not micros: the bar heights are relative either way, and the
    // tooltip and the screen-reader table read the value out.
    value: Number(BigInt(point.spendMicros)) / 1_000_000,
  }));
}

/**
 * One cell per day of the window, oldest first, `1` for a day that had at least
 * one generation served under published evidence.
 *
 * The window is built from the calendar rather than from the response, because
 * a quiet day is a real absence the graph has to show — the API only returns
 * the days that were not quiet.
 */
export function signedDayCells(days: number, signedDays: readonly string[], now: Date = new Date()): HeatmapCell[] {
  const signed = new Set(signedDays.map(utcDay));
  const today = Date.parse(`${utcDay(now)}T00:00:00.000Z`);

  return Array.from({ length: days }, (_, index) => {
    const date = utcDay(new Date(today - (days - 1 - index) * DAY_MS));
    return { date, value: signed.has(date) ? 1 : 0 };
  });
}

/**
 * The longest run of consecutive UTC days with a signed response.
 *
 * Duplicates and unordered input are both tolerated: the days are a set, and
 * the run is measured by walking each day's predecessor.
 */
export function longestSignedStreak(signedDays: readonly string[]): number {
  const days = new Set(signedDays.map(utcDay));
  let longest = 0;

  for (const day of days) {
    // Only start counting from the first day of a run, so each run is walked once.
    if (days.has(utcDay(new Date(Date.parse(`${day}T00:00:00.000Z`) - DAY_MS)))) continue;

    let length = 0;
    let cursor = Date.parse(`${day}T00:00:00.000Z`);
    while (days.has(utcDay(new Date(cursor)))) {
      length += 1;
      cursor += DAY_MS;
    }
    longest = Math.max(longest, length);
  }

  return longest;
}

/** Sums a series of micro-USD strings without ever leaving integer arithmetic. */
export function totalMicros(points: readonly { spendMicros: string }[]): string {
  return points.reduce((total, point) => total + BigInt(point.spendMicros), 0n).toString();
}
