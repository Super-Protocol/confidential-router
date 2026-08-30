import { describe, expect, it } from 'vitest';
import { EvidenceFetchError, evidenceUrlFor, fetchEvidenceBundle } from './evidence-fetcher.js';

const HOST = { hostname: 'router.example.test' };

/** A `fetch` that answers one canned response and records the URL it was called with. */
function fetcherOf(response: Response): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    fetch: (async (input: Parameters<typeof fetch>[0]) => {
      urls.push(typeof input === 'string' ? input : input.toString());
      return response;
    }) as unknown as typeof fetch,
  };
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, ...init });
}

describe('evidenceUrlFor', () => {
  it('is the well-known path on the endpoint hostname', () => {
    expect(evidenceUrlFor(HOST)).toBe('https://router.example.test/.well-known/swarm-evidence');
  });

  it('honours the operator override for clusters where the hostname does not resolve', () => {
    expect(evidenceUrlFor({ ...HOST, evidenceUrl: 'http://mirror.internal/deepseek' })).toBe(
      'http://mirror.internal/deepseek',
    );
  });
});

describe('fetchEvidenceBundle', () => {
  it('returns the parsed document', async () => {
    const { fetch, urls } = fetcherOf(json({ version: '1' }));

    await expect(fetchEvidenceBundle(HOST, { fetcher: fetch })).resolves.toEqual({ version: '1' });
    expect(urls).toEqual(['https://router.example.test/.well-known/swarm-evidence']);
  });

  it('fails on a non-2xx status', async () => {
    const { fetch } = fetcherOf(json({}, { status: 503 }));

    await expect(fetchEvidenceBundle(HOST, { fetcher: fetch })).rejects.toThrow(/returned 503/);
  });

  it('fails on a body that is not JSON', async () => {
    const { fetch } = fetcherOf(new Response('<html>nope</html>'));

    await expect(fetchEvidenceBundle(HOST, { fetcher: fetch })).rejects.toThrow(EvidenceFetchError);
  });

  it('refuses a body over the budget rather than buffering it', async () => {
    const { fetch } = fetcherOf(json({ padding: 'x'.repeat(4096) }));

    await expect(fetchEvidenceBundle(HOST, { fetcher: fetch, maxBytes: 512 })).rejects.toThrow(/budget/);
  });

  it('refuses a declared length over the budget before reading a byte', async () => {
    const { fetch } = fetcherOf(new Response('{}', { headers: { 'content-length': '999999' } }));

    await expect(fetchEvidenceBundle(HOST, { fetcher: fetch, maxBytes: 1024 })).rejects.toThrow(/declared/);
  });

  it('wraps a transport failure', async () => {
    const fetcher = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    await expect(fetchEvidenceBundle(HOST, { fetcher })).rejects.toThrow(/ECONNREFUSED/);
  });
});
