import { describe, expect, it } from 'vitest';
import { average, bucketStarts, coverage, toNumber } from './buckets.js';

describe('bucketStarts', () => {
  it('starts on the UTC boundary containing `from`', () => {
    const starts = bucketStarts(new Date('2026-08-30T13:37:00Z'), new Date('2026-08-30T16:00:00Z'), 'hour');

    expect(starts.map((start) => new Date(start).toISOString())).toEqual([
      '2026-08-30T13:00:00.000Z',
      '2026-08-30T14:00:00.000Z',
      '2026-08-30T15:00:00.000Z',
    ]);
  });

  it('produces one point per UTC day', () => {
    const starts = bucketStarts(new Date('2026-08-28T00:00:00Z'), new Date('2026-08-31T00:00:00Z'), 'day');

    expect(starts).toHaveLength(3);
  });

  it('is empty when the range is empty', () => {
    expect(bucketStarts(new Date('2026-08-30T00:00:00Z'), new Date('2026-08-30T00:00:00Z'), 'day')).toEqual([]);
  });
});

describe('toNumber', () => {
  it('normalises what each driver returns for a bigint sum', () => {
    expect(toNumber('20000000')).toBe(20_000_000);
    expect(toNumber(20_000_000)).toBe(20_000_000);
    expect(toNumber(null)).toBe(0);
  });
});

describe('average', () => {
  it('is null when nothing reported the metric, rather than zero', () => {
    expect(average(0, 0)).toBeNull();
    expect(average('360', '3')).toBe(120);
  });
});

describe('coverage', () => {
  it('is zero for a period with no requests, not a division by zero', () => {
    expect(coverage(0, 0)).toBe(0);
    expect(coverage('3', '4')).toBe(0.75);
  });
});
