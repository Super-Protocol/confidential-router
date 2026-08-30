/**
 * In-memory verdict cache.
 *
 * Ported from Super-Protocol/swarm-cloud `libs/swarm-attestation/src/cache.ts`
 * (BSL-1.1) with permission; see the repository NOTICE.
 */
import { base64UrlEncode } from './fingerprint.js';
import type { TrustedRoot, VerifyCache, VerifyResult } from './types.js';

interface Entry {
  expiresAt: number;
  value: VerifyResult;
}

export interface MemoryCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

export class MemoryCache implements VerifyCache {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, Entry>();

  constructor(options: MemoryCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? 60_000;
    this.maxEntries = options.maxEntries ?? 256;
    this.now = options.now ?? (() => Date.now());
  }

  get(key: string): VerifyResult | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: VerifyResult): void {
    if (this.entries.size >= this.maxEntries) {
      const first = this.entries.keys().next().value;
      if (first !== undefined) this.entries.delete(first);
    }
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }
}

export async function buildCacheKey(
  hostname: string,
  observedTlsFingerprint: string | null,
  trustedRoots: TrustedRoot[],
): Promise<string> {
  const digest = await trustedRootsDigest(trustedRoots);
  // The producer-asserted path has no live observed fingerprint; reserve a
  // distinct cache slot so observed and producer-asserted results don't collide
  // for the same hostname + trusted-roots set.
  return `${hostname}|${observedTlsFingerprint ?? 'producer-asserted'}|${digest}`;
}

async function trustedRootsDigest(trustedRoots: TrustedRoot[]): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    return trustedRoots.map((r) => `${r.name}:${r.pem.length}`).join(',');
  }
  const sorted = [...trustedRoots]
    .map((r) => `${r.name} ${r.pem}`)
    .sort()
    .join('');
  const bytes = new TextEncoder().encode(sorted);
  const digest = await subtle.digest('SHA-256', bytes);
  return base64UrlEncode(digest);
}
