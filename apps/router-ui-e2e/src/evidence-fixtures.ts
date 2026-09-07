import { SESSION_DATA } from './fixtures';

/**
 * What the Overview and Models screens render: three endpoints in the three
 * publication states, the catalogue served from them, and a fresher bundle for
 * "Fetch fresh quote" to answer with.
 *
 * Every object carries `__typename`. Apollo asks for it on every operation and
 * `InMemoryCache` needs it to decide that `...EndpointEvidenceFields` applies to
 * an `Endpoint`; a fixture without it renders an endpoint with its fragment
 * fields silently missing, which looks like a UI bug and is not one.
 */

export const WORKSPACE_ID = SESSION_DATA.me.workspaces[0].id;

export const PUBLISHED_HOST = 'llama-33-70b.tee.swarm.cloud';
export const ROTATING_HOST = 'deepseek-v3.tee.swarm.cloud';
export const UNPUBLISHED_HOST = 'qwen25-72b.tee.swarm.cloud';

export const PUBLISHED_JWS = 'eyJhbGciOiJSUzI1NiJ9.eyJlbmRwb2ludCI6ImxsYW1hIn0.c2lnbmF0dXJlLW9uZQ';
export const ROTATING_JWS = 'eyJhbGciOiJSUzI1NiJ9.eyJlbmRwb2ludCI6ImRlZXBzZWVrIn0.c2lnbmF0dXJlLXR3bw';
export const REFRESHED_JWS = 'eyJhbGciOiJSUzI1NiJ9.eyJlbmRwb2ludCI6ImRlZXBzZWVrIn0.c2lnbmF0dXJlLWZyZXNo';

export const PUBLISHED_DIGEST = 'sha256/9Xk2fT1pQvA7BdE4rL0eQm3XkTpZ8vNc1YsWuHgJoAs';
export const ROTATING_DIGEST = 'sha256/Kd8sB4nR2wYvT6xQmL0aZc9Ef1JhUpGi3NrXoVeSbAo';

/**
 * The same two digests as the console shows and copies them: hex, the spelling
 * the gatekeeper prints and its config file records (SUP-115).
 */
export const PUBLISHED_DIGEST_HEX = 'sha256:f579367d3d6942f03b05d138acbd1e426dd7913a59f2f35cd58b16b87809a00b';
export const ROTATING_DIGEST_HEX = 'sha256:29df2c0789d1db062f4fac5098bd1a65cf447f52615291a2dcdad7a157926c0a';

function snapshot(overrides: Record<string, unknown>) {
  return {
    __typename: 'EvidenceSnapshot',
    id: 'snap-1',
    endpointId: 'ep-1',
    issuedAt: '2026-08-31T09:28:00.000Z',
    fetchedAt: '2026-08-31T09:28:12.000Z',
    quoteAgeSeconds: 12,
    quoteFormat: 'intel-tdx-quote-v5',
    evidenceDigest: PUBLISHED_DIGEST,
    evidenceDigestHex: PUBLISHED_DIGEST_HEX.slice('sha256:'.length),
    certFingerprint: 'sha256/PmQ7dR2xWvB9CkE5sM1fTnZ4aYh6UbLp0GjXoIeVwNs',
    certFingerprintHex: '3e643b751db15af07d0a4139b0cd5f4e767869887a51b2e9d068d7a08795c0db',
    containerImages: ['vllm-tdx@sha256:6b1f9c04'],
    jws: PUBLISHED_JWS,
    measurements: [
      { __typename: 'Measurement', name: 'MRTD', value: '91f4a27c8bd0e5137ac64e0b9d' },
      { __typename: 'Measurement', name: 'RTMR0', value: 'c3a71e05f9db2846bb1407f2ac' },
      { __typename: 'Measurement', name: 'GPU', value: 'H100 CC-mode driver quote 550.90' },
    ],
    chain: [
      {
        __typename: 'CertSummary',
        subject: `CN=${PUBLISHED_HOST}`,
        issuer: 'CN=swarm-pki-subroot',
        notAfter: '2026-11-29T00:00:00.000Z',
        fingerprint: 'sha256/OJ_Y8boMlSj9_dKFf9w8Si1muIFr6EAKgXCdgnEuwLA',
        fingerprintHex: '389fd8f1ba0c9528fdfdd2857fdc3c4a2d66b8816be8400a81709d82712ec0b0',
        isRoot: false,
      },
      {
        __typename: 'CertSummary',
        subject: 'CN=swarm-cloud-prod',
        issuer: 'CN=swarm-cloud-prod',
        notAfter: '2031-01-01T00:00:00.000Z',
        fingerprint: 'sha256/eN7J30KqI96yWxc5VLOpL5VPQYyBKAA2K3HhPBIBXgg',
        fingerprintHex: '78dec9df42aa23deb25b173954b3a92f954f418c812800362b71e13c12015e08',
        isRoot: true,
      },
    ],
    ...overrides,
  };
}

const ENDPOINTS = [
  {
    __typename: 'Endpoint',
    id: 'ep-1',
    name: 'Llama 3.3 70B',
    hostname: PUBLISHED_HOST,
    tee: 'Intel TDX + H100 CC',
    evidenceState: 'PUBLISHED',
    latestEvidence: snapshot({}),
    tokensRouted30d: 598_000_000,
  },
  {
    __typename: 'Endpoint',
    id: 'ep-2',
    name: 'DeepSeek-V3',
    hostname: ROTATING_HOST,
    tee: 'Intel TDX + H100 CC',
    evidenceState: 'STALE',
    latestEvidence: snapshot({
      id: 'snap-2',
      endpointId: 'ep-2',
      quoteAgeSeconds: 740,
      evidenceDigest: ROTATING_DIGEST,
      evidenceDigestHex: ROTATING_DIGEST_HEX.slice('sha256:'.length),
      jws: ROTATING_JWS,
    }),
    tokensRouted30d: 340_000,
  },
  {
    __typename: 'Endpoint',
    id: 'ep-3',
    name: 'Qwen2.5 72B',
    hostname: UNPUBLISHED_HOST,
    tee: 'AMD SEV-SNP',
    evidenceState: 'NOT_PUBLISHED',
    latestEvidence: null,
    tokensRouted30d: 0,
  },
];

export const OVERVIEW_DATA = {
  activitySummary: {
    __typename: 'ActivitySummary',
    spendMicros: '149340000',
    requests: 10_900,
    promptTokens: 700_000_000,
    completionTokens: 80_300_000,
    coveredRequests: 10_900,
    evidenceCoverage: 1,
  },
  activitySeries: [1, 2, 9, 7, 5, 0, 0].map((weight, index) => ({
    __typename: 'ActivityPoint',
    bucket: `2026-08-${25 + index}T00:00:00.000Z`,
    spendMicros: String(weight * 1_000_000),
    requests: weight * 100,
    promptTokens: weight * 10_000,
    completionTokens: weight * 1000,
  })),
  endpoints: ENDPOINTS,
};

export const CATALOGUE_DATA = {
  models: [
    {
      __typename: 'Model',
      id: 'meta/llama-3.3-70b-instruct:tdx',
      slug: 'meta/llama-3.3-70b-instruct:tdx',
      name: 'Llama 3.3 70B Instruct',
      contextLength: 128_000,
      tee: 'Intel TDX + H100 CC',
      pricing: { __typename: 'Pricing', promptPer1m: '280000', completionPer1m: '420000' },
      endpoint: ENDPOINTS[0],
    },
    {
      __typename: 'Model',
      id: 'deepseek/deepseek-v3:tdx',
      slug: 'deepseek/deepseek-v3:tdx',
      name: 'DeepSeek-V3',
      contextLength: 64_000,
      tee: 'Intel TDX + H100 CC',
      pricing: { __typename: 'Pricing', promptPer1m: '310000', completionPer1m: '620000' },
      endpoint: ENDPOINTS[1],
    },
    {
      __typename: 'Model',
      id: 'alibaba/qwen2.5-72b-instruct:snp',
      slug: 'alibaba/qwen2.5-72b-instruct:snp',
      name: 'Qwen2.5 72B Instruct',
      contextLength: 128_000,
      tee: 'AMD SEV-SNP',
      pricing: { __typename: 'Pricing', promptPer1m: '240000', completionPer1m: '360000' },
      endpoint: ENDPOINTS[2],
    },
  ],
};

/**
 * "Fetch fresh quote" is a re-poll: only the rotating endpoint has a newer
 * bundle waiting, and every other endpoint answers `null` — which is the
 * "nothing published" branch, not an error.
 */
export const CONSOLE_OPERATIONS = {
  Overview: OVERVIEW_DATA,
  ModelCatalogue: CATALOGUE_DATA,
  RefreshEvidence: (variables: Record<string, unknown>) => ({
    refreshEvidence:
      variables.endpointId === 'ep-2'
        ? snapshot({
            id: 'snap-fresh',
            endpointId: 'ep-2',
            quoteAgeSeconds: 3,
            issuedAt: '2026-08-31T10:00:00.000Z',
            evidenceDigest: ROTATING_DIGEST,
            evidenceDigestHex: ROTATING_DIGEST_HEX.slice('sha256:'.length),
            jws: REFRESHED_JWS,
          })
        : null,
  }),
};
