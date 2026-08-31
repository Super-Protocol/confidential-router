import { describe, expect, it } from 'vitest';
import { DEFAULT_EXPORT_DAYS, defaultExportRange, exportRangeInstants } from './export-range';

const NOW = new Date('2026-08-31T22:30:00.000Z');

describe('defaultExportRange', () => {
  it('offers the last month of whole UTC days', () => {
    expect(defaultExportRange(NOW)).toEqual({ from: '2026-08-01', to: '2026-08-31' });
    expect(DEFAULT_EXPORT_DAYS).toBe(30);
  });
});

describe('exportRangeInstants', () => {
  it('opens the first day and closes the day after the last, because `to` is exclusive', () => {
    expect(exportRangeInstants({ from: '2026-08-01', to: '2026-08-31' })).toEqual({
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-09-01T00:00:00.000Z',
    });
  });

  it('covers a single day as a whole day, not an empty range', () => {
    expect(exportRangeInstants({ from: '2026-08-31', to: '2026-08-31' })).toEqual({
      from: '2026-08-31T00:00:00.000Z',
      to: '2026-09-01T00:00:00.000Z',
    });
  });

  it('refuses a range that ends before it starts', () => {
    expect(exportRangeInstants({ from: '2026-08-31', to: '2026-08-01' })).toEqual({
      error: 'The end of the range must be on or after its start.',
    });
  });

  it('refuses a half-filled range', () => {
    expect(exportRangeInstants({ from: '', to: '2026-08-31' })).toEqual({
      error: 'Pick both a start and an end date.',
    });
  });
});
