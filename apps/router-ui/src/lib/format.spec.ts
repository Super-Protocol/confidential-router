import { describe, expect, it } from 'vitest';
import { formatCompact, formatUsd, microsToUsd, shortenDigest } from './format';

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
