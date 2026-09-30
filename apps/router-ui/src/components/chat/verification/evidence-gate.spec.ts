import { loadBundle } from '@confidential-router/attestation-fixtures';
import { describe, expect, it, vi } from 'vitest';
import { type CheckId, type CheckStatus, runEvidenceGate } from './evidence-gate';

/**
 * The gate is exercised against the language-neutral conformance vectors in
 * `@confidential-router/attestation-fixtures` — the same bundles the TypeScript
 * verifier and the Go gatekeeper are held to. That is the point: tier 1's claim
 * is "the same checks the extension makes", and a fixture a gatekeeper rejects
 * must not be a fixture the page unlocks on.
 */

const HOSTNAME = 'router.example.test';
const ENDPOINT = 'router';
const API_ORIGIN = 'https://api.router.test';

/** The instant every fixture certificate's validity window is centred on. */
const REFERENCE_NOW = new Date('2026-01-15T12:00:00.000Z');

/** Serves one fixture bundle from the endpoint itself. */
function servesFromEndpoint(bundleName: string): typeof fetch {
  return (async (input: string) => {
    if (input === `https://${HOSTNAME}/.well-known/swarm-evidence`) {
      return new Response(JSON.stringify(loadBundle(bundleName)), { status: 200 });
    }
    throw new Error(`unexpected fetch ${input}`);
  }) as unknown as typeof fetch;
}

function statusOf(checks: { id: CheckId; status: CheckStatus }[], id: CheckId): CheckStatus | undefined {
  return checks.find((check) => check.id === id)?.status;
}

async function run(options: {
  fetcher: typeof fetch;
  now?: Date;
  registryLookup?: Parameters<typeof runEvidenceGate>[0]['registryLookup'];
}) {
  return runEvidenceGate({
    hostname: HOSTNAME,
    endpointName: ENDPOINT,
    apiOrigin: API_ORIGIN,
    now: options.now ?? REFERENCE_NOW,
    fetcher: options.fetcher,
    registryLookup: options.registryLookup,
  });
}

describe('a page that cannot verify at all', () => {
  it('blames its own origin, not the deployment, when Web Crypto is withheld', async () => {
    /*
     * Browsers expose `crypto.subtle` only in a secure context. A console served
     * over plain HTTP on a named host cannot verify anything — and before this
     * check existed, every signature stage failed with "SubtleCrypto is not
     * available", which the panel rendered as "the certificate chain is not
     * valid". That reads as an accusation against the deployment for something
     * that is true of the page.
     */
    const subtle = globalThis.crypto.subtle;
    Object.defineProperty(globalThis.crypto, 'subtle', { value: undefined, configurable: true });
    const fetcher = vi.fn();
    try {
      const result = await run({ fetcher: fetcher as unknown as typeof fetch });

      expect(result.unlocked).toBe(false);
      expect(result.checks).toEqual([expect.objectContaining({ id: 'webcrypto', status: 'fail' })]);
      expect(result.checks[0]?.detail).toMatch(/HTTPS/);
      expect(result.checks[0]?.detail).toMatch(/nothing will be sent/i);
      // And it does not go looking for evidence it could not check anyway.
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(globalThis.crypto, 'subtle', { value: subtle, configurable: true });
    }
  });
});

describe('a bundle a gatekeeper would accept', () => {
  it('unlocks the composer and reports every blocking check as passed', async () => {
    const result = await run({ fetcher: servesFromEndpoint('valid-producer-asserted') });

    expect(result.unlocked).toBe(true);
    for (const id of ['bundle', 'chain', 'signature', 'freshness', 'binding'] as CheckId[]) {
      expect(statusOf(result.checks, id), `${id} should pass`).toBe('pass');
    }
    expect(result.evidence).toMatchObject({ hostname: HOSTNAME, source: 'endpoint' });
    expect(result.evidence?.rootSubject).toBeTruthy();
  });

  it('says the root is not established when the platform publishes no TEE quote', async () => {
    // The state of the demo cloud today: `rootCaTeeQuote` is absent or a
    // placeholder, so the page cannot say the root is one of Super Protocol's.
    // It must report that as "not established", never as a pass and never as a
    // failure, and it must not hold up the composer for it.
    const result = await run({ fetcher: servesFromEndpoint('valid-producer-asserted') });

    expect(statusOf(result.checks, 'root')).toBe('unavailable');
    expect(result.registry).toBeNull();
    expect(result.unlocked).toBe(true);
  });
});

describe('a bundle a gatekeeper would reject', () => {
  it('locks the composer on a bad JWS signature', async () => {
    const result = await run({ fetcher: servesFromEndpoint('jws-bad-signature') });

    expect(result.unlocked).toBe(false);
    expect(statusOf(result.checks, 'signature')).toBe('fail');
  });

  it('locks the composer on an expired certificate', async () => {
    const result = await run({ fetcher: servesFromEndpoint('cert-chain-expired-leaf') });

    expect(result.unlocked).toBe(false);
    expect(statusOf(result.checks, 'chain')).toBe('fail');
  });

  it('locks the composer on a chain whose issuer names do not line up', async () => {
    const result = await run({ fetcher: servesFromEndpoint('cert-chain-issuer-mismatch') });

    expect(result.unlocked).toBe(false);
    expect(statusOf(result.checks, 'chain')).toBe('fail');
  });

  it('locks the composer on a bundle naming another hostname', async () => {
    const result = await run({ fetcher: servesFromEndpoint('fetch-bundle-hostname-mismatch') });

    expect(result.unlocked).toBe(false);
    expect(statusOf(result.checks, 'bundle')).toBe('fail');
  });

  it('locks the composer on evidence older than the freshness window', async () => {
    const result = await run({
      fetcher: servesFromEndpoint('valid-producer-asserted'),
      now: new Date(REFERENCE_NOW.getTime() + 48 * 60 * 60 * 1000),
    });

    expect(result.unlocked).toBe(false);
    expect(statusOf(result.checks, 'freshness')).toBe('fail');
  });

  it('locks the composer when the published TLS certificate is not the one the evidence signs', async () => {
    const result = await run({ fetcher: servesFromEndpoint('tls-fingerprint-producer-asserted-mismatch') });

    expect(result.unlocked).toBe(false);
    expect(statusOf(result.checks, 'binding')).toBe('fail');
  });

  it('locks the composer when the bundle publishes no tlsLeaf at all', async () => {
    // A page cannot see the live TLS certificate, so a bundle with nothing to
    // bind to leaves the signature attached to no channel. That is a fail, not
    // an "unavailable": the check had an answer and the answer was no.
    const result = await run({ fetcher: servesFromEndpoint('tls-fingerprint-no-binding') });

    expect(result.unlocked).toBe(false);
    expect(statusOf(result.checks, 'binding')).toBe('fail');
  });
});

describe('where the bundle comes from', () => {
  it('falls back to this router’s passthrough when the endpoint refuses a cross-origin fetch', async () => {
    // A CORS refusal surfaces in a browser as a rejected promise with no status,
    // which is exactly what is simulated here.
    const fetcher = vi.fn(async (input: string) => {
      if (input.startsWith(`https://${HOSTNAME}`)) throw new TypeError('Failed to fetch');
      if (input === `${API_ORIGIN}/v1/evidence/${ENDPOINT}`) {
        return new Response(JSON.stringify(loadBundle('valid-producer-asserted')), { status: 200 });
      }
      throw new Error(`unexpected fetch ${input}`);
    });

    const result = await run({ fetcher: fetcher as unknown as typeof fetch });

    expect(result.unlocked).toBe(true);
    expect(result.evidence?.source).toBe('router');
  });

  it('reports both refusals when neither source answers', async () => {
    const fetcher = (async () => new Response('', { status: 503 })) as unknown as typeof fetch;

    const result = await run({ fetcher });

    expect(result.unlocked).toBe(false);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]?.detail).toContain('status 503');
  });
});

describe('the root check', () => {
  const measurement = 'd'.repeat(64);

  /** A bundle whose signed payload publishes an mrEnclave the registry can index. */
  function bundleWithMeasurement(): Record<string, unknown> {
    const bundle = loadBundle('valid-producer-asserted');
    return {
      ...bundle,
      rootCaTeeQuote: { format: 'intel-tdx-quote-v5', collateral: { measurements: { mrenclave: measurement } } },
    };
  }

  function serves(body: Record<string, unknown>): typeof fetch {
    return (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
  }

  it('passes when the registry vouches for the published measurement', async () => {
    const result = await run({
      fetcher: serves(bundleWithMeasurement()),
      registryLookup: async () => ({ status: 'vouched', measurement, url: 'https://registry.test/entry.json' }),
    });

    expect(statusOf(result.checks, 'root')).toBe('pass');
    expect(result.evidence?.measurement).toBe(measurement);
    expect(result.evidence?.quoteFormat).toBe('intel-tdx-quote-v5');
  });

  it('fails when the registry has no signature for it', async () => {
    const result = await run({
      fetcher: serves(bundleWithMeasurement()),
      registryLookup: async () => ({ status: 'not-in-registry', measurement }),
    });

    expect(statusOf(result.checks, 'root')).toBe('fail');
  });

  it('reports "not established" when the registry could not be reached, and still unlocks', async () => {
    // The registry is a Git host over plain HTTPS. Being unable to ask it is not
    // a statement about the endpoint, and it must not silently read as one.
    const result = await run({
      fetcher: serves(bundleWithMeasurement()),
      registryLookup: async () => ({ status: 'unavailable', reason: 'offline' }),
    });

    expect(statusOf(result.checks, 'root')).toBe('unavailable');
    expect(result.unlocked).toBe(true);
  });

  it('does not consult the registry for a placeholder quote', async () => {
    // The deployed platform publishes `{"status":"not-implemented"}` until the
    // root CA quote ships (SUP-157).
    const lookUp = vi.fn();
    const bundle = { ...loadBundle('valid-producer-asserted'), rootCaTeeQuote: { status: 'not-implemented' } };

    const result = await run({ fetcher: serves(bundle), registryLookup: lookUp as never });

    expect(lookUp).not.toHaveBeenCalled();
    expect(statusOf(result.checks, 'root')).toBe('unavailable');
    expect(result.checks.find((check) => check.id === 'root')?.detail).toContain('no TEE quote');
  });
});
