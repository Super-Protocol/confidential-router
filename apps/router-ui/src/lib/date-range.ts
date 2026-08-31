/**
 * The console's aggregate queries take a half-open `[from, to)` range of ISO
 * instants, and `activitySeries` buckets on UTC boundaries.
 */
export interface DateRange {
  from: string;
  to: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The last `days` whole UTC days, today included.
 *
 * Whole days rather than "now minus 168 hours" for two reasons: `Bucket.DAY`
 * starts its buckets on UTC boundaries, so a ragged range returns a first
 * bucket covering part of a day; and a range that only changes at UTC midnight
 * is a stable Apollo cache key, where a millisecond-precise `to` would miss the
 * cache on every render.
 */
export function lastUtcDays(days: number, now: Date = new Date()): DateRange {
  const endOfToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + DAY_MS;
  return {
    from: new Date(endOfToday - days * DAY_MS).toISOString(),
    to: new Date(endOfToday).toISOString(),
  };
}

const BUCKET_LABEL = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });

/** `2026-08-25T00:00:00.000Z` → `Aug 25`, for a bar's tooltip and its row header. */
export function formatBucketLabel(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : BUCKET_LABEL.format(date);
}
