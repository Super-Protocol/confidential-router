import { describe, expect, it } from 'vitest';
import { evidenceStateOf, quoteAgeMs } from './evidence-state.js';

const NOW = new Date('2026-08-30T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

describe('evidenceStateOf', () => {
  it('is NOT_PUBLISHED when nothing has been fetched', () => {
    expect(evidenceStateOf(null, DAY, NOW)).toBe('NOT_PUBLISHED');
  });

  it('is PUBLISHED inside the freshness window', () => {
    expect(evidenceStateOf({ issuedAt: new Date(NOW.getTime() - 60_000) }, DAY, NOW)).toBe('PUBLISHED');
  });

  it('is PUBLISHED exactly at the edge of the window', () => {
    expect(evidenceStateOf({ issuedAt: new Date(NOW.getTime() - DAY) }, DAY, NOW)).toBe('PUBLISHED');
  });

  it('is STALE one millisecond past it', () => {
    expect(evidenceStateOf({ issuedAt: new Date(NOW.getTime() - DAY - 1) }, DAY, NOW)).toBe('STALE');
  });

  it('treats a bundle dated in the future as fresh rather than negative', () => {
    const future = { issuedAt: new Date(NOW.getTime() + 60_000) };

    expect(quoteAgeMs(future, NOW)).toBe(0);
    expect(evidenceStateOf(future, DAY, NOW)).toBe('PUBLISHED');
  });
});
