import { describe, expect, it } from 'vitest';
import { formatCount, formatExact, formatMs, formatRatio, formatTokensPerSecond } from './metrics';

describe('formatCount', () => {
  it('prints small counts exactly and large ones compactly', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(842)).toBe('842');
    expect(formatCount(11_000)).toBe('11K');
    expect(formatCount(598_000_000)).toBe('598M');
  });
});

describe('formatExact', () => {
  it('groups thousands, because a table cell is read not scanned', () => {
    expect(formatExact(1_234_567)).toBe('1,234,567');
  });
});

describe('formatMs', () => {
  it('switches to seconds above a second', () => {
    expect(formatMs(312)).toBe('312 ms');
    expect(formatMs(1450)).toBe('1.45 s');
    expect(formatMs(64_000)).toBe('64.0 s');
  });

  it('distinguishes "no time reported" from zero', () => {
    expect(formatMs(null)).toBe('—');
    expect(formatMs(undefined)).toBe('—');
    expect(formatMs(0)).toBe('0 ms');
  });
});

describe('formatTokensPerSecond', () => {
  it('renders throughput to one decimal, and nothing for a missing value', () => {
    expect(formatTokensPerSecond(48.23)).toBe('48.2 tok/s');
    expect(formatTokensPerSecond(null)).toBe('—');
  });
});

describe('formatRatio', () => {
  it('never rounds an incomplete coverage up to 100%', () => {
    expect(formatRatio(1)).toBe('100%');
    expect(formatRatio(0.9999)).toBe('99.9%');
  });

  it('keeps a tiny non-zero ratio distinguishable from none at all', () => {
    expect(formatRatio(0)).toBe('0%');
    expect(formatRatio(0.0004)).toBe('<1%');
  });

  it('drops the decimal when there is nothing behind it', () => {
    expect(formatRatio(0.5)).toBe('50%');
    expect(formatRatio(0.842)).toBe('84.2%');
  });
});
