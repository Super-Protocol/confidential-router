import { describe, expect, it } from 'vitest';
import {
  centsToMicros,
  InvalidMicroAmountError,
  microsToCents,
  microsToUsdString,
  parseMicros,
  usdToMicros,
} from './money.js';

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

describe('usdToMicros', () => {
  it('converts what an operator types on a command line', () => {
    expect(usdToMicros('100')).toBe(100_000_000);
    expect(usdToMicros('2.50')).toBe(2_500_000);
    expect(usdToMicros('0.000001')).toBe(1);
  });

  it('refuses anything it would have to round, so --grant cannot lose a fraction silently', () => {
    expect(() => usdToMicros('1.0000001')).toThrow(InvalidMicroAmountError);
  });

  it('refuses zero, a negative amount and anything that is not a number', () => {
    for (const value of ['0', '0.00', '-5', '', 'ten', '1e2', '$100', '1,000']) {
      expect(() => usdToMicros(value)).toThrow(InvalidMicroAmountError);
    }
  });

  it('names the field it was given, so the CLI error says --grant', () => {
    expect(() => usdToMicros('abc', '--grant')).toThrow(/--grant/);
  });
});
