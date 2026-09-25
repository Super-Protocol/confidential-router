import { describe, expect, it } from 'vitest';
import { eventUuid } from './event-uuid.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('eventUuid', () => {
  it('produces a syntactic version-4 UUID', () => {
    expect(eventUuid('signup_completed', 'user-1')).toMatch(UUID);
  });

  it('is the same value for the same row, so a retried hook is one conversion', () => {
    expect(eventUuid('signup_completed', 'user-1')).toBe(eventUuid('signup_completed', 'user-1'));
  });

  it('separates two events about the same row', () => {
    expect(eventUuid('signup_completed', 'user-1')).not.toBe(eventUuid('invite_redeemed', 'user-1'));
  });

  it('cannot be confused by where one part ends and the next begins', () => {
    // Joining on a separator that can appear in a part would make these equal,
    // and two different events would deduplicate into one.
    expect(eventUuid('a', 'bc')).not.toBe(eventUuid('ab', 'c'));
  });
});
