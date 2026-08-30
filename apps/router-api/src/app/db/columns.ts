import type { ColumnOptions, PrimaryColumnOptions } from 'typeorm';
import { BigIntNumberTransformer, TimestampTransformer } from './transformers.js';

/**
 * Column presets shared by every entity. Centralised because the schema has to
 * be byte-identical on PostgreSQL (production) and SQLite (dev, tests, CI unit
 * runs) — see `docs/contracts/data-model.md`.
 *
 * Each preset comes in a `@Column` and a `@PrimaryColumn` flavour: TypeORM's
 * `PrimaryColumnOptions` forbids `nullable: true`, and keeping the two typed
 * apart is what makes that a compile error rather than a runtime surprise.
 */

/** UUID/ULID primary and foreign keys. SQLite has no `uuid` type. */
const ID = { type: 'varchar', length: 64 } as const satisfies ColumnOptions;

/** Epoch-millisecond timestamp. See `TimestampTransformer`. */
const TIMESTAMP = { type: 'bigint', transformer: TimestampTransformer } as const satisfies ColumnOptions;

/** Counter or micro-USD amount. See `BigIntNumberTransformer`. */
const BIG_INT = { type: 'bigint', transformer: BigIntNumberTransformer } as const satisfies ColumnOptions;

export function idColumn(options: ColumnOptions = {}): ColumnOptions {
  return { ...ID, ...options };
}

export function idPrimaryColumn(options: PrimaryColumnOptions = {}): PrimaryColumnOptions {
  return { ...ID, ...options };
}

export function timestampColumn(options: ColumnOptions = {}): ColumnOptions {
  return { ...TIMESTAMP, ...options };
}

export function timestampPrimaryColumn(options: PrimaryColumnOptions = {}): PrimaryColumnOptions {
  return { ...TIMESTAMP, ...options };
}

export function bigIntColumn(options: ColumnOptions = {}): ColumnOptions {
  return { ...BIG_INT, ...options };
}

/** Small structured payload. `simple-json` is TEXT on both drivers. */
export function jsonColumn(options: ColumnOptions = {}): ColumnOptions {
  return { type: 'simple-json', ...options };
}
