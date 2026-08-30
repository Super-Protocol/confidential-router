/** Bucket sizes the Activity screen offers. Both divide the epoch evenly, so a
 * day bucket is a UTC day and an hour bucket a UTC hour, on every database. */
export const BUCKET_MS = {
  hour: 3_600_000,
  day: 86_400_000,
} as const;

export type BucketSize = keyof typeof BUCKET_MS;

/**
 * Every bucket start in `[from, to)`, so a chart has a point for a quiet hour
 * instead of a gap the client has to guess about.
 */
export function bucketStarts(from: Date, to: Date, size: BucketSize): number[] {
  const step = BUCKET_MS[size];
  const first = Math.floor(from.getTime() / step) * step;
  const starts: number[] = [];
  for (let bucket = first; bucket < to.getTime(); bucket += step) {
    starts.push(bucket);
  }
  return starts;
}

/** Raw aggregate columns come back as strings on PostgreSQL and numbers on SQLite. */
export function toNumber(value: unknown): number {
  if (value === null || value === undefined) {
    return 0;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** An average that is genuinely absent — no request reported the metric — stays null. */
export function average(sum: unknown, samples: unknown): number | null {
  const count = toNumber(samples);
  return count === 0 ? null : toNumber(sum) / count;
}

/** Share of requests served while the endpoint had published evidence. */
export function coverage(covered: unknown, requests: unknown): number {
  const total = toNumber(requests);
  return total === 0 ? 0 : toNumber(covered) / total;
}
