import type { Bucket } from '../generated/graphql';

/**
 * The three windows Activity and Logs offer. Anything longer than a month is a
 * report, not a console screen — and `activitySeries` buckets by hour or day
 * only, so a quarter would draw ninety columns nobody can read.
 */
export type RangeKey = '24h' | '7d' | '30d';

export const RANGE_KEYS: RangeKey[] = ['24h', '7d', '30d'];

export interface RangeOption {
  key: RangeKey;
  /** The toggle's label. */
  short: string;
  /** Spoken form, for `aria-label` and the chart's text equivalent. */
  long: string;
  hours: number;
  bucket: Bucket;
}

export const RANGE_OPTIONS: Record<RangeKey, RangeOption> = {
  '24h': { key: '24h', short: '24h', long: 'Past 24 hours', hours: 24, bucket: 'HOUR' },
  '7d': { key: '7d', short: '7d', long: 'Past 7 days', hours: 24 * 7, bucket: 'DAY' },
  '30d': { key: '30d', short: '30d', long: 'Past 30 days', hours: 24 * 30, bucket: 'DAY' },
};

export const DEFAULT_RANGE: RangeKey = '24h';

/** The fixed window of the "usage by model" chart, independent of the picker. */
export const USAGE_BY_MODEL_DAYS = 30;

export interface ResolvedRange {
  /** Inclusive start, ISO-8601. */
  from: string;
  /** Exclusive end, ISO-8601. */
  to: string;
  bucket: Bucket;
}

/**
 * Turns a range key into the `from`/`to` pair every activity query takes.
 *
 * `now` is a parameter rather than a `new Date()` inside, because these
 * variables key the Apollo cache: a value that changes every render would make
 * every render a cache miss and a refetch. Callers pin it (see `useNow`).
 */
export function resolveRange(key: RangeKey, now: Date): ResolvedRange {
  const option = RANGE_OPTIONS[key];
  const to = now.getTime();
  return {
    from: new Date(to - option.hours * 3_600_000).toISOString(),
    to: new Date(to).toISOString(),
    bucket: option.bucket,
  };
}

/** The last `days` whole days ending now — the "usage by model" window. */
export function resolveDays(days: number, now: Date): { from: string; to: string } {
  const to = now.getTime();
  return { from: new Date(to - days * 24 * 3_600_000).toISOString(), to: new Date(to).toISOString() };
}

export function isRangeKey(value: string | null | undefined): value is RangeKey {
  return value === '24h' || value === '7d' || value === '30d';
}

/**
 * Labels a bucket start for a chart axis. Hourly buckets carry no date — a
 * 24-hour chart is one day and repeating it 24 times is noise — and daily
 * buckets carry no time, which is always midnight UTC.
 */
export function formatBucketLabel(bucket: Bucket, iso: string): string {
  const date = new Date(iso);
  return bucket === 'HOUR'
    ? new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
    : new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(date);
}
