import { describe, expect, it } from 'vitest';
import { DEFAULT_RANGE, formatBucketLabel, isRangeKey, resolveDays, resolveRange } from './ranges';

const NOW = new Date('2026-08-31T12:00:00.000Z');

describe('resolveRange', () => {
  it('buckets a day by hour and a week or a month by day', () => {
    expect(resolveRange('24h', NOW).bucket).toBe('HOUR');
    expect(resolveRange('7d', NOW).bucket).toBe('DAY');
    expect(resolveRange('30d', NOW).bucket).toBe('DAY');
  });

  it('ends the window at the instant it was given, not at a day boundary', () => {
    expect(resolveRange('24h', NOW).to).toBe('2026-08-31T12:00:00.000Z');
    expect(resolveRange('24h', NOW).from).toBe('2026-08-30T12:00:00.000Z');
  });

  it('measures 30 days back from the same instant', () => {
    expect(resolveRange('30d', NOW).from).toBe('2026-08-01T12:00:00.000Z');
  });

  it('defaults to the last 24 hours', () => {
    expect(DEFAULT_RANGE).toBe('24h');
  });
});

describe('resolveDays', () => {
  it('returns the trailing window of whole days ending now', () => {
    expect(resolveDays(30, NOW)).toEqual({ from: '2026-08-01T12:00:00.000Z', to: '2026-08-31T12:00:00.000Z' });
  });
});

describe('isRangeKey', () => {
  it('accepts only the three offered windows', () => {
    expect(isRangeKey('7d')).toBe(true);
    expect(isRangeKey('90d')).toBe(false);
    expect(isRangeKey(null)).toBe(false);
  });
});

describe('formatBucketLabel', () => {
  it('drops the date from an hourly bucket and the time from a daily one', () => {
    expect(formatBucketLabel('HOUR', '2026-08-31T14:00:00.000Z')).toMatch(/^\d{2}:\d{2}$/);
    expect(formatBucketLabel('DAY', '2026-08-31T00:00:00.000Z')).toMatch(/^\d{1,2} \w{3}$/);
  });
});
