import { describe, expect, it } from 'vitest';
import { ANY, DEFAULT_FILTERS, resolveFilters } from './filters';

const NOW = new Date('2026-08-31T12:00:00.000Z');

describe('resolveFilters', () => {
  it('leaves an unset filter off the query rather than sending an empty list', () => {
    const { filter } = resolveFilters(DEFAULT_FILTERS, NOW);

    expect(filter.modelIds).toBeUndefined();
    expect(filter.apiKeyIds).toBeUndefined();
    expect(filter.statuses).toBeUndefined();
  });

  it('turns the range into the window every generation is matched against', () => {
    const { filter } = resolveFilters({ ...DEFAULT_FILTERS, range: '7d' }, NOW);

    expect(filter.from).toBe('2026-08-24T12:00:00.000Z');
    expect(filter.to).toBe('2026-08-31T12:00:00.000Z');
  });

  it('wraps a chosen model, key and status as the single-element lists the API takes', () => {
    const { filter } = resolveFilters(
      { ...DEFAULT_FILTERS, modelId: 'model-1', apiKeyId: 'key-1', status: 'ERROR' },
      NOW,
    );

    expect(filter.modelIds).toEqual(['model-1']);
    expect(filter.apiKeyIds).toEqual(['key-1']);
    expect(filter.statuses).toEqual(['ERROR']);
  });

  it('defaults to newest first', () => {
    expect(resolveFilters(DEFAULT_FILTERS, NOW).sort).toEqual({ field: 'CREATED_AT', direction: 'DESC' });
  });

  it('carries the same narrowing to the CSV window, so the export matches the table', () => {
    const state = { ...DEFAULT_FILTERS, range: '30d' as const, modelId: 'model-1', status: 'OK' as const };
    const { filter, window } = resolveFilters(state, NOW);

    expect(window).toEqual({
      from: filter.from,
      to: filter.to,
      modelIds: ['model-1'],
      apiKeyIds: undefined,
      statuses: ['OK'],
    });
  });

  it('uses a sentinel for "no filter", because Radix reserves the empty string', () => {
    expect(DEFAULT_FILTERS.modelId).toBe(ANY);
    expect(ANY).not.toBe('');
  });
});
