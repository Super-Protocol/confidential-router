import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatCompact,
  formatDate,
  formatUsd,
  microsToUsd,
  microsToUsdInput,
  shortenDigest,
  usdToMicros,
} from './format';

describe('microsToUsd', () => {
  it('converts integer micro-USD', () => {
    expect(microsToUsd('170650000')).toBeCloseTo(170.65, 6);
    expect(microsToUsd('0')).toBe(0);
  });

  it('handles amounts past the safe-integer range for micros', () => {
    // 10 billion dollars in micros is 1e16 — beyond Number.MAX_SAFE_INTEGER.
    expect(microsToUsd('10000000000000000')).toBe(10_000_000_000);
  });

  it('keeps negative balances negative', () => {
    expect(microsToUsd('-1500000')).toBeCloseTo(-1.5, 6);
  });
});

describe('formatUsd', () => {
  it('renders two decimals with a currency symbol', () => {
    expect(formatUsd('170650000')).toBe('$170.65');
  });
});

describe('formatCompact', () => {
  it('shortens large counts', () => {
    expect(formatCompact(780_300_000)).toBe('780.3M');
    expect(formatCompact(942)).toBe('942');
  });
});

describe('shortenDigest', () => {
  it('keeps the algorithm prefix and both ends of the digest', () => {
    expect(shortenDigest('sha256/abcdefghijklmnopqrstuvwxyz')).toBe('sha256/abcdef…uvwxyz');
  });

  it('leaves a digest that is already short alone', () => {
    expect(shortenDigest('sha256/abcdef')).toBe('sha256/abcdef');
  });

  it('handles a bare digest with no algorithm prefix', () => {
    expect(shortenDigest('abcdefghijklmnopqrstuvwxyz')).toBe('abcdef…uvwxyz');
  });
});

describe('usdToMicros', () => {
  it('converts a typed amount without going through a float', () => {
    expect(usdToMicros('12.34')).toBe('12340000');
    expect(usdToMicros('25')).toBe('25000000');
    expect(usdToMicros(' 0.000001 ')).toBe('1');
  });

  it('rejects anything that is not a plain amount', () => {
    expect(usdToMicros('')).toBeNull();
    expect(usdToMicros('$25')).toBeNull();
    expect(usdToMicros('-5')).toBeNull();
    expect(usdToMicros('1.2345678')).toBeNull();
  });

  it('round-trips through the edit form', () => {
    expect(microsToUsdInput(usdToMicros('12.5') as string)).toBe('12.5');
  });
});

describe('formatBytes', () => {
  it('scales to the unit a release actually uses', () => {
    expect(formatBytes(940)).toBe('940 B');
    expect(formatBytes(14_800_000)).toBe('14.8 MB');
  });

  it('renders an unknown size as a dash rather than "0 B"', () => {
    expect(formatBytes(0)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
  });
});

describe('formatDate', () => {
  it("renders the UTC day, not the viewer's", () => {
    // 00:30 UTC is still the previous day west of Greenwich.
    expect(formatDate('2026-08-31T00:30:00.000Z')).toBe('Aug 31, 2026');
  });

  it('falls back rather than rendering "Invalid Date"', () => {
    expect(formatDate(null)).toBe('—');
    expect(formatDate('not a date')).toBe('—');
    expect(formatDate(undefined, 'Never')).toBe('Never');
  });
});
