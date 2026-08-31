import { describe, expect, it } from 'vitest';
import { HEATMAP_DAYS, longestSignedStreak, signedDayCells, spendBars, totalMicros, utcDay } from './profile-data';

/** A fixed instant late in a UTC day, so a naive local-time helper would slip. */
const NOW = new Date('2026-08-31T22:30:00.000Z');

describe('spendBars', () => {
  it('labels each bucket in UTC and converts micros to dollars', () => {
    expect(
      spendBars([
        { bucket: '2026-08-30T00:00:00.000Z', spendMicros: '1500000' },
        { bucket: '2026-08-31T00:00:00.000Z', spendMicros: '0' },
      ]),
    ).toEqual([
      { label: 'Aug 30', value: 1.5 },
      { label: 'Aug 31', value: 0 },
    ]);
  });
});

describe('signedDayCells', () => {
  it('fills the whole window, oldest first, ending today', () => {
    const cells = signedDayCells(7, [], NOW);

    expect(cells).toHaveLength(7);
    expect(cells[0].date).toBe('2026-08-25');
    expect(cells[6].date).toBe('2026-08-31');
  });

  it('marks a day the API returned and leaves the quiet ones at zero', () => {
    const cells = signedDayCells(7, ['2026-08-29T00:00:00.000Z'], NOW);

    expect(cells.filter((cell) => cell.value > 0).map((cell) => cell.date)).toEqual(['2026-08-29']);
  });

  it('ignores a day outside the window rather than stretching it', () => {
    const cells = signedDayCells(7, ['2026-01-01T00:00:00.000Z'], NOW);

    expect(cells.every((cell) => cell.value === 0)).toBe(true);
  });

  it('produces whole calendar weeks for the screen default', () => {
    expect(HEATMAP_DAYS % 7).toBe(0);
    expect(signedDayCells(HEATMAP_DAYS, [], NOW)).toHaveLength(HEATMAP_DAYS);
  });
});

describe('longestSignedStreak', () => {
  it('is zero when nothing was signed', () => {
    expect(longestSignedStreak([])).toBe(0);
  });

  it('measures the longest run, not the last one', () => {
    expect(
      longestSignedStreak([
        '2026-08-01T00:00:00.000Z',
        '2026-08-02T00:00:00.000Z',
        '2026-08-03T00:00:00.000Z',
        '2026-08-10T00:00:00.000Z',
      ]),
    ).toBe(3);
  });

  it('does not join days a gap separates', () => {
    expect(longestSignedStreak(['2026-08-01T00:00:00.000Z', '2026-08-03T00:00:00.000Z'])).toBe(1);
  });

  it('counts a run over a month boundary', () => {
    expect(longestSignedStreak(['2026-08-31T00:00:00.000Z', '2026-09-01T00:00:00.000Z'])).toBe(2);
  });

  it('tolerates duplicates and an unordered response', () => {
    expect(
      longestSignedStreak([
        '2026-08-03T00:00:00.000Z',
        '2026-08-01T00:00:00.000Z',
        '2026-08-02T12:00:00.000Z',
        '2026-08-02T00:00:00.000Z',
      ]),
    ).toBe(3);
  });
});

describe('totalMicros', () => {
  it('sums beyond what a double represents exactly', () => {
    expect(totalMicros([{ spendMicros: '9007199254740993' }, { spendMicros: '1' }])).toBe('9007199254740994');
  });
});

describe('utcDay', () => {
  it('takes the UTC day, not the local one', () => {
    expect(utcDay('2026-08-31T23:59:59.999Z')).toBe('2026-08-31');
  });
});
