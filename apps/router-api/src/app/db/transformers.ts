import type { ValueTransformer } from 'typeorm';

/**
 * Timestamps are stored as epoch milliseconds in a `bigint` column.
 *
 * PostgreSQL and SQLite disagree about every date type there is — `timestamptz`
 * vs. a `date` string, driver-side parsing on one and not the other. An integer
 * is the one representation both store, compare and sort identically, which is
 * what the data model means by "portable column types only".
 */
export const TimestampTransformer: ValueTransformer = {
  to: (value?: Date | null): number | null => (value ? value.getTime() : null),
  from: (value?: string | number | null): Date | null =>
    value === null || value === undefined ? null : new Date(Number(value)),
};

/**
 * Money and token counters are `bigint` columns exposed to TypeScript as
 * `number`. `pg` hands back a string, `better-sqlite3` a number; both are
 * normalised here.
 *
 * All of these are micro-USD or token counts. `Number.MAX_SAFE_INTEGER` is
 * ~9.0e15 micro-USD — about nine billion dollars on a single row — so the
 * precision the `number` type gives up is not reachable by this domain.
 */
export const BigIntNumberTransformer: ValueTransformer = {
  to: (value?: number | null): number | null => (value === null || value === undefined ? null : value),
  from: (value?: string | number | null): number | null =>
    value === null || value === undefined ? null : Number(value),
};

/**
 * Read-only mapping of a timestamp column that Better Auth owns and whose
 * physical type therefore differs per database (`date` under SQLite, `timestamp`
 * under PostgreSQL). Accepts whatever the driver returns.
 */
export const ForeignDateTransformer: ValueTransformer = {
  to: (value?: Date | null): Date | null => value ?? null,
  from: (value?: string | number | Date | null): Date | null => {
    if (value === null || value === undefined) {
      return null;
    }
    return value instanceof Date ? value : new Date(typeof value === 'number' ? value : String(value));
  },
};
