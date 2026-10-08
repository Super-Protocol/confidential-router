import { describe, expect, it } from 'vitest';
import {
  buildSidecarConfig,
  goDuration,
  renderSidecarConfig,
  type SidecarConfigInput,
  TWO_FACTOR_TRUST,
  UnrenderableEndpointError,
} from './sidecar-config.js';

const MEASUREMENT_A = 'a'.repeat(64);
const MEASUREMENT_B = 'b'.repeat(64);
const PINNED_DIGEST = 'sha256/SwSl8nkqLsNHn9rsW7Dfek9mGTeDePm8MsHPQ3Z-490';

function input(overrides: Partial<SidecarConfigInput> = {}): SidecarConfigInput {
  return {
    endpoints: [
      {
        name: 'partner-llama',
        baseUrl: 'https://llama.partner.example',
        listenPort: 19001,
        pinnedEvidenceDigest: PINNED_DIGEST,
      },
      {
        name: 'acme-mistral',
        baseUrl: 'https://mistral.acme.example:8443',
        listenPort: 19000,
        pinnedEvidenceDigest: null,
      },
    ],
    trustedMeasurements: [MEASUREMENT_B, MEASUREMENT_A],
    adminListen: '127.0.0.1:9465',
    reattestIntervalMs: 600_000,
    ...overrides,
  };
}

describe('the rendered sidecar config', () => {
  it('is byte-for-byte what the golden file says', async () => {
    // The golden file is the contract between router-api and the Go sidecar, so
    // it is committed and readable rather than inlined: a change to it is a
    // change to the seam, and should look like one in a diff.
    await expect(renderSidecarConfig(input())).toMatchFileSnapshot('./testdata/sidecar-config.golden.yaml');
  });

  it('renders every endpoint two-factor: the listed cloud and its own approved deployment', () => {
    // SUP-252: a trusted cloud no longer admits every deployment on it. Each
    // endpoint carries the digest its admin pinned as `trustedEvidence`, and the
    // core requires it *and* the measurement list.
    const document = buildSidecarConfig(input());

    for (const endpoint of document.endpoints) {
      expect(endpoint.trust).toBe(TWO_FACTOR_TRUST);
    }
    const byName = new Map(document.endpoints.map((endpoint) => [endpoint.name, endpoint]));
    expect(byName.get('partner-llama')?.trustedEvidence).toEqual([PINNED_DIGEST]);
  });

  it('renders an endpoint with nothing approved as an empty pin list, so it is still verified', () => {
    // Not left out: the sidecar has to verify it to report the digest an admin
    // approves, and refuses it as `digest-not-pinned` meanwhile.
    const document = buildSidecarConfig(input());

    expect(document.endpoints.find((endpoint) => endpoint.name === 'acme-mistral')?.trustedEvidence).toEqual([]);
  });

  it('is fail-closed everywhere, with no setting that could render otherwise', () => {
    const document = buildSidecarConfig(input());

    expect(document.defaults.failMode).toBe('closed');
    expect(document.endpoints.every((endpoint) => endpoint.failMode === 'closed')).toBe(true);
    expect(renderSidecarConfig(input())).not.toContain('open');
  });

  it('carries no secret', () => {
    // The upstream API key is injected by router-api on the egress leg and the
    // sidecar passes `Authorization` through untouched (ADR-003 §8), so this file
    // is readable without being sensitive. Nothing about it should ever change.
    const rendered = renderSidecarConfig(input());

    for (const forbidden of ['apiKey', 'api_key', 'Authorization', 'Bearer', 'token', 'secret', 'password']) {
      expect(rendered.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it('listens on loopback only, for every endpoint', () => {
    for (const endpoint of buildSidecarConfig(input()).endpoints) {
      expect(endpoint.listen).toMatch(/^127\.0\.0\.1:\d+$/);
    }
  });

  it('is stable under reordering, so an unchanged database renders unchanged bytes', () => {
    // The writer compares rendered bytes to decide whether the sidecar reloads,
    // and a reload force-re-attests every endpoint. A render that varied with row
    // order would re-attest the world whenever a query came back differently.
    const forwards = renderSidecarConfig(input());
    const backwards = renderSidecarConfig(
      input({
        endpoints: [...input().endpoints].reverse(),
        trustedMeasurements: [MEASUREMENT_A, MEASUREMENT_B],
      }),
    );

    expect(backwards).toBe(forwards);
  });

  it('collapses a duplicate measurement rather than listing it twice', () => {
    const document = buildSidecarConfig(input({ trustedMeasurements: [MEASUREMENT_A, MEASUREMENT_A] }));

    expect(document.attestedRoots.trustedMeasurements).toEqual([MEASUREMENT_A]);
  });

  it('keeps the attested-root anchor on, because the whole verdict rests on it', () => {
    expect(buildSidecarConfig(input()).attestedRoots.enabled).toBe(true);
  });

  it('renders an empty trust list as an empty list, not as an absent one', () => {
    // An absent `trustedMeasurements` would fall back to registry-signed
    // measurements alone — exactly the "the list is decorative" semantics
    // ADR-008 §3 rejects. An empty list admits nothing, which is the honest
    // reading of "the admin has trusted no cloud yet".
    const document = buildSidecarConfig(input({ trustedMeasurements: [] }));

    expect(document.attestedRoots.trustedMeasurements).toEqual([]);
    expect(renderSidecarConfig(input({ trustedMeasurements: [] }))).toContain('trustedMeasurements: []');
  });

  it('reduces an upstream to scheme and authority, dropping any path', () => {
    const document = buildSidecarConfig(
      input({
        endpoints: [{ name: 'a', baseUrl: 'https://a.example/v1/', listenPort: 19000, pinnedEvidenceDigest: null }],
      }),
    );

    expect(document.endpoints[0].upstream).toBe('https://a.example');
  });

  it('refuses a plain-HTTP upstream, because there is no channel to bind', () => {
    expect(() =>
      buildSidecarConfig(
        input({
          endpoints: [{ name: 'a', baseUrl: 'http://a.example', listenPort: 19000, pinnedEvidenceDigest: null }],
        }),
      ),
    ).toThrow(UnrenderableEndpointError);
  });

  it('refuses an unparseable base URL by naming the endpoint', () => {
    expect(() =>
      buildSidecarConfig(
        input({ endpoints: [{ name: 'broken', baseUrl: 'not a url', listenPort: 19000, pinnedEvidenceDigest: null }] }),
      ),
    ).toThrow(/"broken"/);
  });
});

describe('goDuration', () => {
  it('renders whole units the way an operator would write them', () => {
    expect(goDuration(600_000)).toBe('10m');
    expect(goDuration(3_600_000)).toBe('1h');
    expect(goDuration(60_000)).toBe('1m');
    expect(goDuration(5_000)).toBe('5s');
  });

  it('falls back to milliseconds rather than rounding a value away', () => {
    expect(goDuration(1_500)).toBe('1500ms');
    expect(goDuration(90_000)).toBe('90s');
  });
});
