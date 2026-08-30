import { describe, expect, it } from 'vitest';
import { BigIntNumberTransformer, ForeignDateTransformer, TimestampTransformer } from './transformers.js';

describe('TimestampTransformer', () => {
  it('stores a Date as epoch milliseconds', () => {
    expect(TimestampTransformer.to(new Date('2026-08-30T12:00:00.000Z'))).toBe(1788091200000);
  });

  it('reads back both driver shapes', () => {
    // `pg` returns bigint as a string, `better-sqlite3` as a number.
    expect(TimestampTransformer.from('1788091200000')).toEqual(new Date('2026-08-30T12:00:00.000Z'));
    expect(TimestampTransformer.from(1788091200000)).toEqual(new Date('2026-08-30T12:00:00.000Z'));
  });

  it('round-trips', () => {
    const now = new Date();
    expect(TimestampTransformer.from(TimestampTransformer.to(now))).toEqual(now);
  });

  it('passes null through in both directions', () => {
    expect(TimestampTransformer.to(null)).toBeNull();
    expect(TimestampTransformer.from(null)).toBeNull();
    expect(TimestampTransformer.from(undefined)).toBeNull();
  });
});

describe('BigIntNumberTransformer', () => {
  it('normalises the string PostgreSQL returns to a number', () => {
    expect(BigIntNumberTransformer.from('5000000')).toBe(5_000_000);
    expect(BigIntNumberTransformer.from(5_000_000)).toBe(5_000_000);
  });

  it('keeps a signed ledger amount signed', () => {
    expect(BigIntNumberTransformer.from('-1234')).toBe(-1234);
  });

  it('is exact across the whole range this domain can reach', () => {
    // Micro-USD. 9e15 micros is about nine billion dollars on one row.
    const large = 9_000_000_000_000_000;
    expect(large).toBeLessThan(Number.MAX_SAFE_INTEGER);
    expect(BigIntNumberTransformer.from(String(large))).toBe(large);
  });

  it('keeps zero rather than turning it into null', () => {
    expect(BigIntNumberTransformer.from(0)).toBe(0);
    expect(BigIntNumberTransformer.to(0)).toBe(0);
  });
});

describe('ForeignDateTransformer', () => {
  it('accepts every shape a Better Auth timestamp column can come back as', () => {
    const expected = new Date('2026-08-30T12:00:00.000Z');
    expect(ForeignDateTransformer.from(expected)).toEqual(expected);
    expect(ForeignDateTransformer.from('2026-08-30T12:00:00.000Z')).toEqual(expected);
    expect(ForeignDateTransformer.from(1788091200000)).toEqual(expected);
    expect(ForeignDateTransformer.from(null)).toBeNull();
  });
});
