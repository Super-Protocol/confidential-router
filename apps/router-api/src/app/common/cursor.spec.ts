import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from './cursor.js';

describe('cursors', () => {
  it('round-trips a sort value and its tie-breaker', () => {
    const cursor = { value: 1_756_600_000_000, id: 'gen-01J6' };

    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('is opaque: nothing readable leaks into the URL', () => {
    expect(encodeCursor({ value: 1, id: 'gen-1' })).not.toContain('gen-1');
  });

  it('rejects a cursor a client made up', () => {
    for (const cursor of ['', 'not-base64!', Buffer.from('{}').toString('base64url')]) {
      expect(() => decodeCursor(cursor)).toThrow(BadRequestException);
    }
  });
});
