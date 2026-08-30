import { describe, expect, it } from 'vitest';
import { generationId, ulid } from './ulid.js';

describe('ulid', () => {
  it('is 26 Crockford base32 characters', () => {
    expect(ulid()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('sorts lexicographically in time order, which is why it is not a UUID', () => {
    const earlier = ulid(1_700_000_000_000);
    const later = ulid(1_700_000_001_000);

    expect(earlier < later).toBe(true);
  });

  it('does not repeat within a millisecond', () => {
    const ids = new Set(Array.from({ length: 1_000 }, () => ulid(1_700_000_000_000)));

    expect(ids.size).toBe(1_000);
  });
});

describe('generationId', () => {
  it('is the prefixed form the API returns as the response id', () => {
    expect(generationId()).toMatch(/^gen-[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});
