import { describe, expect, it } from 'vitest';
import { saltedHash } from './salted-hash.js';

const SECRET = 'a'.repeat(32);

describe('saltedHash', () => {
  it('is stable for the same secret and value', () => {
    expect(saltedHash(SECRET, '203.0.113.7')).toBe(saltedHash(SECRET, '203.0.113.7'));
  });

  it('is 64 hex characters, the width of every column that holds one', () => {
    expect(saltedHash(SECRET, '203.0.113.7')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('separates two values', () => {
    expect(saltedHash(SECRET, '203.0.113.7')).not.toBe(saltedHash(SECRET, '203.0.113.8'));
  });

  it('separates two deployments, so one cannot recognise the other’s fingerprints', () => {
    expect(saltedHash(SECRET, '203.0.113.7')).not.toBe(saltedHash('b'.repeat(32), '203.0.113.7'));
  });

  it('never contains the value it hashed', () => {
    expect(saltedHash(SECRET, '203.0.113.7')).not.toContain('203.0.113.7');
  });
});
