import { describe, expect, it } from 'vitest';
import { centsToMicros, InvalidMicroAmountError, microsToCents, microsToUsdString, parseMicros } from './money.js';

describe('parseMicros', () => {
  it('accepts an integer string, including a negative one', () => {
    expect(parseMicros('20000000')).toBe(20_000_000);
    expect(parseMicros(' -5450 ')).toBe(-5_450);
  });

  it('rejects anything that is not an integer, so no amount is silently rounded', () => {
    for (const value of ['20.5', '2e7', '', 'abc', '0x10', '1_000']) {
      expect(() => parseMicros(value)).toThrow(InvalidMicroAmountError);
    }
  });

  it('rejects an amount past the safe integer range', () => {
    expect(() => parseMicros('9007199254740993')).toThrow(InvalidMicroAmountError);
  });
});

describe('microsToCents', () => {
  it('converts a whole number of cents', () => {
    expect(microsToCents(20_000_000)).toBe(2_000);
    expect(centsToMicros(2_000)).toBe(20_000_000);
  });

  it('refuses an amount no card processor could charge exactly', () => {
    expect(() => microsToCents(5_450)).toThrow(InvalidMicroAmountError);
    expect(() => microsToCents(0)).toThrow(InvalidMicroAmountError);
    expect(() => microsToCents(-10_000)).toThrow(InvalidMicroAmountError);
  });
});

describe('microsToUsdString', () => {
  it('keeps all six digits rather than rounding to cents', () => {
    expect(microsToUsdString(20_000_000)).toBe('20.000000');
    expect(microsToUsdString(5_450)).toBe('0.005450');
    expect(microsToUsdString(-1_000_000)).toBe('-1.000000');
  });
});
