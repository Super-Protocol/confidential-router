/**
 * Behaviour that the language-neutral vectors cannot express: caller-side argument
 * validation and the verdict cache, both of which live outside the wire contract.
 */
import {
  EVIDENCE_PATH,
  loadConformanceManifest,
  loadTrustedRoots,
  makeCaseFetcher,
} from '@confidential-router/attestation-fixtures';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryCache } from '../cache.js';
import type { TrustedRoot, VerifyParams } from '../types.js';
import { verifyHostname } from '../verify.js';

const manifest = loadConformanceManifest();
const roots = loadTrustedRoots();

function caseById(id: string) {
  const found = manifest.cases.find((c) => c.id === id);
  if (!found) throw new Error(`missing conformance case "${id}"`);
  return found;
}

const happyPath = caseById('valid-rsa-deployment');
const trustedRoots: TrustedRoot[] = happyPath.request.trustedRoots.map((name) => {
  const root = roots.find((r) => r.name === name);
  if (!root) throw new Error(`unknown root ${name}`);
  return { name: root.name, pem: root.pem };
});

/** Wraps the happy-path fetcher so the test can count how often the network was hit. */
function countingFetcher(): { fetcher: typeof fetch; calls: () => number } {
  const inner = makeCaseFetcher(happyPath);
  let calls = 0;
  const fetcher: typeof fetch = async (input, init) => {
    calls++;
    return inner(input, init);
  };
  return { fetcher, calls: () => calls };
}

function happyParams(overrides: Partial<VerifyParams> = {}): VerifyParams {
  return {
    hostname: happyPath.request.hostname,
    trustedRoots,
    observedTlsFingerprint: happyPath.request.observedTlsFingerprint,
    maxBundleAge: happyPath.request.maxBundleAge,
    now: new Date(happyPath.request.now),
    fetcher: makeCaseFetcher(happyPath),
    ...overrides,
  };
}

describe('verifyHostname argument validation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects an empty hostname before touching the network', async () => {
    const result = await verifyHostname(happyParams({ hostname: '' }));
    expect(result).toEqual({ ok: false, stage: 'fetch', reason: 'hostname must be a non-empty string' });
  });

  it('rejects a non-array trustedRoots', async () => {
    const result = await verifyHostname(happyParams({ trustedRoots: undefined as unknown as TrustedRoot[] }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.stage).toBe('untrusted-root');
  });

  it('falls back to the global fetch and reports a transport failure as stage fetch', async () => {
    const globalFetch = vi.fn<typeof fetch>().mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
    vi.stubGlobal('fetch', globalFetch);

    const result = await verifyHostname({ ...happyParams(), fetcher: undefined as unknown as typeof fetch });

    expect(globalFetch).toHaveBeenCalledWith(`https://${happyPath.request.hostname}${EVIDENCE_PATH}`, {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
    expect(result).toEqual({ ok: false, stage: 'fetch', reason: 'request failed: getaddrinfo ENOTFOUND' });
  });

  it('fails at the fetch stage when the runtime has no fetch at all', async () => {
    vi.stubGlobal('fetch', undefined);

    const result = await verifyHostname({ ...happyParams(), fetcher: undefined as unknown as typeof fetch });

    expect(result).toEqual({
      ok: false,
      stage: 'fetch',
      reason: 'no fetcher available; pass params.fetcher or run with global fetch',
    });
  });
});

describe('verdict cache', () => {
  it('serves a repeat verification from the cache without refetching', async () => {
    const cache = new MemoryCache({ ttlMs: 60_000, now: () => 0 });
    const { fetcher, calls } = countingFetcher();

    const first = await verifyHostname(happyParams({ cache, fetcher }));
    const second = await verifyHostname(happyParams({ cache, fetcher }));

    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
    expect(calls()).toBe(1);
  });

  it('does not let a permissive maxBundleAge satisfy a stricter caller', async () => {
    const cache = new MemoryCache({ ttlMs: 60_000, now: () => 0 });
    const { fetcher, calls } = countingFetcher();

    const permissive = await verifyHostname(happyParams({ cache, fetcher, maxBundleAge: 24 * 60 * 60 * 1000 }));
    const strict = await verifyHostname(happyParams({ cache, fetcher, maxBundleAge: 60_000 }));

    expect(permissive.ok).toBe(true);
    expect(strict.ok).toBe(false);
    if (strict.ok) throw new Error('unreachable');
    expect(strict.stage).toBe('jws');
    expect(calls()).toBe(2);
  });

  it('never caches a failed verdict', async () => {
    const cache = new MemoryCache({ ttlMs: 60_000, now: () => 0 });
    const { fetcher, calls } = countingFetcher();
    const strictParams = happyParams({ cache, fetcher, maxBundleAge: 60_000 });

    expect((await verifyHostname(strictParams)).ok).toBe(false);
    expect((await verifyHostname(strictParams)).ok).toBe(false);
    expect(calls()).toBe(2);
  });

  it('keys observed and producer-asserted verdicts separately', async () => {
    const producerAsserted = caseById('valid-producer-asserted');
    const cache = new MemoryCache({ ttlMs: 60_000, now: () => 0 });

    const observed = await verifyHostname(happyParams({ cache }));
    const asserted = await verifyHostname({
      hostname: producerAsserted.request.hostname,
      trustedRoots,
      maxBundleAge: producerAsserted.request.maxBundleAge,
      now: new Date(producerAsserted.request.now),
      fetcher: makeCaseFetcher(producerAsserted),
      cache,
    });

    expect(observed.ok && observed.channelBinding).toBe('observed');
    expect(asserted.ok && asserted.channelBinding).toBe('producer-asserted');
  });
});
