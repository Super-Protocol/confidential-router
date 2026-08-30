import { describe, expect, it } from 'vitest';
import { buildCacheKey, MemoryCache } from '../cache.js';
import type { TrustedRoot, VerifyResult } from '../types.js';

const verdict: VerifyResult = { ok: false, stage: 'jws', reason: 'test' };

describe('MemoryCache', () => {
  it('returns a stored entry inside the TTL and drops it after', () => {
    let now = 0;
    const cache = new MemoryCache({ ttlMs: 1_000, now: () => now });
    cache.set('k', verdict);

    now = 999;
    expect(cache.get('k')).toEqual(verdict);

    now = 1_000;
    expect(cache.get('k')).toBeUndefined();
  });

  it('returns undefined for an unknown key', () => {
    expect(new MemoryCache().get('nope')).toBeUndefined();
  });

  it('evicts the oldest entry once maxEntries is reached', () => {
    const cache = new MemoryCache({ maxEntries: 2, now: () => 0 });
    cache.set('a', verdict);
    cache.set('b', verdict);
    cache.set('c', verdict);

    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toEqual(verdict);
    expect(cache.get('c')).toEqual(verdict);
  });
});

describe('buildCacheKey', () => {
  const roots: TrustedRoot[] = [
    { name: 'a', pem: 'PEM-A' },
    { name: 'b', pem: 'PEM-B' },
  ];

  it('is stable regardless of the order of the trusted roots', async () => {
    expect(await buildCacheKey('host', 'sha256/x', roots)).toBe(
      await buildCacheKey('host', 'sha256/x', [...roots].reverse()),
    );
  });

  it('changes when the trust store changes', async () => {
    expect(await buildCacheKey('host', 'sha256/x', roots)).not.toBe(
      await buildCacheKey('host', 'sha256/x', [{ name: 'a', pem: 'PEM-C' }]),
    );
  });

  it('separates the producer-asserted slot from any observed fingerprint', async () => {
    expect(await buildCacheKey('host', null, roots)).toContain('producer-asserted');
    expect(await buildCacheKey('host', null, roots)).not.toBe(await buildCacheKey('host', 'sha256/x', roots));
  });
});
