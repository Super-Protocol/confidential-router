import { describe, expect, it } from 'vitest';
import { formatBucketLabel, lastUtcDays } from './date-range';

describe('lastUtcDays', () => {
  it('covers whole UTC days and ends at the start of tomorrow', () => {
    expect(lastUtcDays(7, new Date('2026-08-31T14:22:09.512Z'))).toEqual({
      from: '2026-08-25T00:00:00.000Z',
      to: '2026-09-01T00:00:00.000Z',
    });
  });

  it('is the same range at any hour of the day, so the cache key is stable', () => {
    const morning = lastUtcDays(7, new Date('2026-08-31T00:00:00.000Z'));
    const night = lastUtcDays(7, new Date('2026-08-31T23:59:59.999Z'));

    expect(morning).toEqual(night);
  });

  it('crosses a month boundary', () => {
    expect(lastUtcDays(3, new Date('2026-03-01T09:00:00.000Z')).from).toBe('2026-02-27T00:00:00.000Z');
  });
});

describe('formatBucketLabel', () => {
  it('labels a bucket by its UTC day', () => {
    expect(formatBucketLabel('2026-08-25T00:00:00.000Z')).toBe('Aug 25');
  });

  it('leaves an unparseable value alone rather than rendering "Invalid Date"', () => {
    expect(formatBucketLabel('not-a-date')).toBe('not-a-date');
  });
});
