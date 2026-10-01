import type { RootAttestation, RootTeeEvidence } from '@confidential-router/attestation';
import { loadBundle } from '@confidential-router/attestation-fixtures';
import { describe, expect, it, vi } from 'vitest';
import { type CheckId, type CheckStatus, runEvidenceGate } from './evidence-gate';
import { badgeTier, lockedReasonOf, pageTierState } from './tiers';

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

/** The sentence a row shows the viewer — which is what most of SUP-185 was about. */
function detailOf(result: { checks: { id: CheckId; detail: string }[] }, id: CheckId): string {
  return result.checks.find((check) => check.id === id)?.detail ?? '';
}

async function run(options: {
  fetcher: typeof fetch;
  now?: Date;
  registryLookup?: Parameters<typeof runEvidenceGate>[0]['registryLookup'];
  rootAttestationReader?: Parameters<typeof runEvidenceGate>[0]['rootAttestationReader'];
}) {
  return runEvidenceGate({
    hostname: HOSTNAME,
    endpointName: ENDPOINT,
    apiOrigin: API_ORIGIN,
    now: options.now ?? REFERENCE_NOW,
    fetcher: options.fetcher,
    registryLookup: options.registryLookup,
    rootAttestationReader: options.rootAttestationReader,
  });
}

/**
 * The root attestation a fixture root would have if the platform had issued it.
 *
 * The fixture PKI's roots carry no attestation extensions — they are plain
 * self-signed CAs — so the branches of the root row are selected here instead.
 * The reader itself is held to a real `Super Swarm Root CA` in
 * `libs/attestation/src/__tests__/root-tee-evidence.spec.ts`; what these cases
 * decide is what the *screen says* about each thing the reader can find.
 */
function reads(attestation: Partial<RootAttestation>): Parameters<typeof runEvidenceGate>[0]['rootAttestationReader'] {
  return async () => ({
    challengeType: null,
    networkType: null,
    carriesEvidence: false,
    evidence: null,
    error: null,
    ...attestation,
  });
}

/** The SEV-SNP evidence a real `Super Swarm Root CA` carries today. */
const LIVE_EVIDENCE: RootTeeEvidence = {
  type: 'sev-snp-qemu',
  label: 'AMD SEV-SNP (QEMU)',
  registryFolder: 'sev-snp',
  build: 'build-370',
  reportMeasurement: 'a'.repeat(96),
  keyBinding: true,
  // The gate never reads the policy or TCB fields — they are the inspector's —
  // so the branches these cases select do not depend on them.
  security: null,
};

/** The live platform's root, as `readRootAttestation` reports it. */
const LIVE_SEV_SNP: Partial<RootAttestation> = {
  challengeType: 'sev-snp',
  networkType: 'untrusted',
  carriesEvidence: true,
  evidence: LIVE_EVIDENCE,
};

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

  it('carries the signed snapshot through, so the inspector draws the attested document', async () => {
    /*
     * The one claim the attestation inspector rests on: the graph it draws comes
     * out of the JWS this gate just verified, not out of a second request. If the
     * snapshot stopped arriving here the inspector would have to fetch it, and
     * then there would be two documents on one screen with one signature between
     * them.
     */
    const result = await run({ fetcher: servesFromEndpoint('valid-producer-asserted') });
    const payload = JSON.parse(
      Buffer.from(
        (loadBundle('valid-producer-asserted') as { jws: string }).jws.split('.')[1] as string,
        'base64url',
      ).toString('utf8'),
    ) as { evidence: unknown };

    expect(result.evidence?.snapshot).toEqual(payload.evidence);
    expect(result.evidence?.kind).toBe('DeploymentEvidence');
    expect(result.evidence?.jws).toBe((loadBundle('valid-producer-asserted') as { jws: string }).jws);
  });

  it('summarises every certificate of the chain, with the terminal one marked as the root', async () => {
    // The inspector lists the chain down to the TEE-quoted root, and the
    // fingerprint a reader compares with their gatekeeper's trusted root is the
    // last one — so "which one is the root" has to be a fact, not a guess made in
    // the view layer.
    const result = await run({ fetcher: servesFromEndpoint('valid-producer-asserted') });
    const chain = result.evidence?.chain ?? [];

    expect(chain.length).toBe((loadBundle('valid-producer-asserted') as { certChain: string[] }).certChain.length);
    expect(chain.filter((certificate) => certificate.isRoot)).toHaveLength(1);
    expect(chain.at(-1)?.isRoot).toBe(true);
    expect(chain.at(-1)?.subject).toBe(result.evidence?.rootSubject);
    // The root's fingerprint is the one the chain validation already derived, so
    // the two surfaces cannot disagree about which value to compare.
    expect(chain.at(-1)?.fingerprint).toBe(result.evidence?.rootFingerprint);
    for (const certificate of chain) {
      expect(certificate.fingerprint).toMatch(/^sha256\/[A-Za-z0-9_-]{43}$/);
    }
  });

  it('says the root is not established when nothing anywhere carries a quote', async () => {
    // A bundle with no `rootCaTeeQuote` whose root carries no TEE evidence either:
    // the page cannot say the root is one of Super Protocol's. It must report that
    // as "not established", never as a pass and never as a failure, and it must
    // not hold up the composer for it.
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

  it('fails when the registry has no signature for it, and locks the composer', async () => {
    /*
     * A negative answer from the one thing outside the deployment that could give
     * one, verified in this page under a pinned key — and the endpoint Gatekeeper
     * refuses. Unreachable today (no producer publishes a measurement), but if one
     * ever does and it is not registered, locking is the right outcome: the
     * alternative is the badge's strongest sentence over a VM the registry has
     * just declined to vouch for.
     */
    const result = await run({
      fetcher: serves(bundleWithMeasurement()),
      registryLookup: async () => ({ status: 'not-in-registry', measurement }),
    });

    expect(statusOf(result.checks, 'root')).toBe('fail');
    expect(result.unlocked).toBe(false);
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
    // It may only claim an absence it actually observed, and it observed two
    // places: the bundle field and the root certificate.
    expect(detailOf(result, 'root')).toContain("Neither this bundle's rootCaTeeQuote nor the root certificate");
  });
});

/**
 * The other half of SUP-185's title: "and unlocks an endpoint Gatekeeper refuses".
 *
 * The rule is a distinction, so both sides of it need pinning. A row that came
 * back *negative* holds the composer; a row nobody could *answer* never does. Get
 * the first wrong and the screen says its strongest sentence over a forgery it has
 * already proven; get the second wrong and a gap on the platform's side locks the
 * demo surface permanently.
 */
describe('what holds the composer shut', () => {
  function serves(body: Record<string, unknown>): typeof fetch {
    return (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
  }

  const placeholder = () => ({
    ...loadBundle('valid-producer-asserted'),
    rootCaTeeQuote: { status: 'not-implemented' },
  });

  it('a root row that could not be answered does not, so the live platform stays usable', async () => {
    /*
     * The live endpoint: the quote is there, its key binding holds, and only the
     * registry rebuild is out of a browser's reach. Locking here would shut the
     * demo for a platform limitation the screen has already disclosed in words,
     * and it would stay shut until sp-vm measurements became browser-derivable —
     * which is to say, for good.
     */
    const result = await run({
      fetcher: serves(placeholder()),
      rootAttestationReader: reads(LIVE_SEV_SNP),
    });

    expect(statusOf(result.checks, 'root')).toBe('unavailable');
    expect(result.unlocked).toBe(true);
  });

  it('a registry nobody could reach does not lock it either', async () => {
    const measurement = 'f'.repeat(64);
    const bundle = {
      ...loadBundle('valid-producer-asserted'),
      rootCaTeeQuote: { format: 'amd-sev-snp', collateral: { measurements: { mrenclave: measurement } } },
    };

    const result = await run({
      fetcher: serves(bundle),
      registryLookup: async () => ({ status: 'unavailable', reason: 'offline' }),
      rootAttestationReader: reads(LIVE_SEV_SNP),
    });

    expect(statusOf(result.checks, 'root')).toBe('unavailable');
    expect(result.unlocked).toBe(true);
  });

  it('an unreadable extension does not lock it: "cannot read" is not "answered no"', async () => {
    const result = await run({
      fetcher: serves(placeholder()),
      rootAttestationReader: reads({ carriesEvidence: true, error: 'malformed varint' }),
    });

    expect(statusOf(result.checks, 'root')).toBe('unavailable');
    expect(result.unlocked).toBe(true);
  });

  it('a failed root row does, and the badge stops reading as a pass', async () => {
    /*
     * The contradiction QA traced on a minted lifted-evidence endpoint: a red row
     * reading "Do not trust this endpoint on the strength of this page", behind a
     * badge reading "Verified by this page", over an open composer. `pageTierState`
     * derives the badge from `unlocked`, so closing the gate closes both.
     */
    const result = await run({
      fetcher: serves(placeholder()),
      rootAttestationReader: reads({ ...LIVE_SEV_SNP, evidence: { ...LIVE_EVIDENCE, keyBinding: false } }),
    });

    expect(statusOf(result.checks, 'root')).toBe('fail');
    expect(result.unlocked).toBe(false);
    expect(pageTierState(result)).toBe('fail');
    expect(badgeTier(pageTierState(result), 'unavailable').label).toBe('Evidence did not check out');
    // The reason shown where the send button is has to be the root row's own
    // words, not a generic sentence about evidence.
    expect(lockedReasonOf(result)).toContain("does not commit to this root's public key");
  });

  it('still unlocks when every row that can be answered passed', async () => {
    const measurement = 'b'.repeat(64);
    const bundle = {
      ...loadBundle('valid-producer-asserted'),
      rootCaTeeQuote: { format: 'amd-sev-snp', collateral: { measurements: { mrenclave: measurement } } },
    };

    const result = await run({
      fetcher: serves(bundle),
      registryLookup: async () => ({ status: 'vouched', measurement, url: 'https://registry.test/e.json' }),
      rootAttestationReader: reads(LIVE_SEV_SNP),
    });

    expect(statusOf(result.checks, 'root')).toBe('pass');
    expect(result.unlocked).toBe(true);
  });
});

/**
 * SUP-185. The live platform leaves `rootCaTeeQuote` a placeholder and puts a full
 * SEV-SNP report in the root certificate's TEE-evidence extension. The row used to
 * answer that with "the platform publishes no TEE quote for this hostname yet" —
 * a false statement about the platform, made by the one screen whose whole design
 * rule is that a word may only appear when the thing behind it happened.
 */
describe('a root whose certificate carries the quote', () => {
  function serves(body: Record<string, unknown>): typeof fetch {
    return (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
  }

  const placeholder = () => ({
    ...loadBundle('valid-producer-asserted'),
    rootCaTeeQuote: { status: 'not-implemented' },
  });

  it('never claims the platform published nothing', async () => {
    const result = await run({
      fetcher: serves(placeholder()),
      rootAttestationReader: reads(LIVE_SEV_SNP),
    });

    expect(detailOf(result, 'root')).not.toContain('publishes no TEE quote');
    expect(detailOf(result, 'root')).not.toContain('Neither this bundle');
  });

  it('reports the evidence type, the release and the key binding it did check', async () => {
    const result = await run({
      fetcher: serves(placeholder()),
      rootAttestationReader: reads(LIVE_SEV_SNP),
    });

    const detail = detailOf(result, 'root');
    expect(detail).toContain('AMD SEV-SNP (QEMU)');
    expect(detail).toContain('build-370');
    expect(detail).toContain("commits to this root's own public key");
    expect(result.evidence).toMatchObject({
      rootEvidenceLabel: 'AMD SEV-SNP (QEMU)',
      rootBuild: 'build-370',
      rootKeyBinding: true,
      rootNetworkType: 'untrusted',
    });
  });

  it('warns that Gatekeeper may refuse the endpoint it just unlocked', async () => {
    /*
     * The contradiction a demo user hit in four pasted commands: the badge said
     * "Verified by this page", the composer was open, and the panel's own
     * quick-start returned `exit 3`. The row has to name that possibility.
     */
    const result = await run({
      fetcher: serves(placeholder()),
      rootAttestationReader: reads(LIVE_SEV_SNP),
    });

    expect(statusOf(result.checks, 'root')).toBe('unavailable');
    expect(result.unlocked).toBe(true);
    expect(detailOf(result, 'root')).toContain('may reach a different verdict');
    expect(detailOf(result, 'root')).toContain('including refusing it');
  });

  it('still does not hand the report measurement to the registry', async () => {
    /*
     * The trap in the obvious fix. The report's own 48-byte MEASUREMENT is hex of
     * a length `isMeasurementHex` accepts, so it would sail into a lookup — and
     * the registry indexes the *normalised* launch digest, so the answer would be
     * `not-in-registry`: the page accusing a sound deployment. Zero lookups is the
     * assertion, because a wrong red here is worse than the honest question mark.
     */
    const lookUp = vi.fn();

    const result = await run({
      fetcher: serves(placeholder()),
      registryLookup: lookUp as never,
      rootAttestationReader: reads(LIVE_SEV_SNP),
    });

    expect(lookUp).not.toHaveBeenCalled();
    expect(result.registry).toBeNull();
    expect(result.evidence?.measurement).toBeNull();
  });

  it('fails the row when the quote attests some other key', async () => {
    // The one negative a page can establish on its own, so it is a cross rather
    // than a question mark — and the copy says not to trust the endpoint on this
    // page's word.
    const result = await run({
      fetcher: serves(placeholder()),
      rootAttestationReader: reads({
        ...LIVE_SEV_SNP,
        evidence: { ...LIVE_EVIDENCE, keyBinding: false },
      }),
    });

    expect(statusOf(result.checks, 'root')).toBe('fail');
    expect(detailOf(result, 'root')).toContain("does not commit to this root's public key");
    // No bundle measurement here, so the sentence about one must not appear.
    expect(detailOf(result, 'root')).not.toContain('also publishes a measurement');
    // And the composer stays shut: a row saying "do not trust this endpoint" over
    // an open composer is the contradiction, not a nuance (SUP-185).
    expect(result.unlocked).toBe(false);
  });

  it('refuses a non-binding quote even when the bundle asserts a vouched measurement', async () => {
    /*
     * The collision, and the defect CTO caught in the first cut of this fix: the
     * refusal lived inside the no-measurement branch, so a bundle that also
     * published an `mrenclave` the registry vouches for skipped it entirely and
     * painted the row green — this screen's strongest sentence — while the page
     * already held the proof that the root's own quote attests a different key.
     *
     * The measurement is a producer-controlled string that nothing binds to this
     * root, so it cannot answer the question the quote just failed. Lifting real
     * hardware evidence onto a foreign key and naming a registered VM beside it is
     * two strings an attacker supplies; the row must not add them up to a pass.
     */
    const measurement = 'e'.repeat(64);
    const vouched = vi.fn(async () => ({
      status: 'vouched' as const,
      measurement,
      url: 'https://registry.test/entry.json',
    }));
    const bundle = {
      ...loadBundle('valid-producer-asserted'),
      rootCaTeeQuote: { format: 'amd-sev-snp', collateral: { measurements: { mrenclave: measurement } } },
    };

    const result = await run({
      fetcher: serves(bundle),
      registryLookup: vouched,
      rootAttestationReader: reads({ ...LIVE_SEV_SNP, evidence: { ...LIVE_EVIDENCE, keyBinding: false } }),
    });

    expect(statusOf(result.checks, 'root')).toBe('fail');
    // Not consulted at all: no verdict could change this row, and a page that has
    // decided to refuse should not be making another cross-origin request.
    expect(vouched).not.toHaveBeenCalled();
    expect(result.registry).toBeNull();
    // And the reader is told why the registry was not the thing that decided it.
    expect(detailOf(result, 'root')).toContain('also publishes a measurement');
    expect(detailOf(result, 'root')).toContain('It was not consulted.');
    expect(result.unlocked).toBe(false);
  });

  it('says it could not read an extension rather than that there was none', async () => {
    const result = await run({
      fetcher: serves(placeholder()),
      rootAttestationReader: reads({ carriesEvidence: true, error: 'malformed varint' }),
    });

    expect(statusOf(result.checks, 'root')).toBe('unavailable');
    expect(detailOf(result, 'root')).toContain('could not read (malformed varint)');
    expect(detailOf(result, 'root')).not.toContain('carries no TEE');
  });

  it('leaves a producer-published measurement in charge when there is one', async () => {
    /*
     * Reading the extension must not shadow the path that already works: a
     * producer that publishes a real registry measurement still gets the registry
     * answer, not a "cannot finish" note.
     */
    const measurement = 'c'.repeat(64);
    const bundle = {
      ...loadBundle('valid-producer-asserted'),
      rootCaTeeQuote: { format: 'amd-sev-snp', collateral: { measurements: { mrenclave: measurement } } },
    };

    const result = await run({
      fetcher: serves(bundle),
      registryLookup: async () => ({ status: 'vouched', measurement, url: 'https://registry.test/e.json' }),
      rootAttestationReader: reads(LIVE_SEV_SNP),
    });

    expect(statusOf(result.checks, 'root')).toBe('pass');
  });
});
