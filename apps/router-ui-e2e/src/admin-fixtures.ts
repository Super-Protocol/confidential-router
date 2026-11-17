/**
 * What the admin section's operations answer in the browser suite.
 *
 * Shaped against the contract in `docs/contracts/console-graphql.md`
 * § "As shipped (SUP-225) — the admin section", which is also what
 * `apps/router-ui/schema.contract-pending.graphql` types the client against.
 * When SUP-225 lands, these fixtures are what a real round trip has to match.
 */

const TRUSTED_MEASUREMENT = 'a'.repeat(64);
const ROGUE_MEASUREMENT = 'b'.repeat(64);

const EVIDENCE = {
  __typename: 'ExternalEndpointEvidence',
  snapshotId: 'ext-snap-1',
  fetchedAt: '2026-10-06T11:58:00.000Z',
  issuedAt: '2026-10-06T11:50:00.000Z',
  evidenceDigest: 'sha256/AAAABBBBCCCCDDDDEEEEFFFF',
  evidenceDigestHex: '1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff',
  certFingerprint: 'sha256/EEEEFFFF000011112222',
  certFingerprintHex: 'ffffeeeeddddccccbbbbaaaa000099998888777766665555444433332222111',
  quoteFormat: 'intel-tdx-quote-v5',
  containerImages: [
    'ghcr.io/example/vllm@sha256:1111111111111111111111111111111111111111111111111111111111111111',
    'ghcr.io/example/gatekeeper@sha256:2222222222222222222222222222222222222222222222222222222222222222',
  ],
  workloads: [
    {
      __typename: 'EvidenceWorkload',
      kind: 'Deployment',
      name: 'vllm',
      namespace: 'qwen3-coder',
      containers: ['vllm', 'init-weights'],
    },
    {
      __typename: 'EvidenceWorkload',
      kind: 'StatefulSet',
      name: 'cache',
      namespace: 'qwen3-coder',
      containers: ['redis'],
    },
  ],
  measurements: [{ __typename: 'Measurement', name: 'MRTD', value: 'd8f1c0ab' }],
};

const VERIFIED_ENDPOINT = {
  __typename: 'ExternalEndpoint',
  id: 'ext-1',
  name: 'qwen3-coder',
  baseUrl: 'https://qwen3-coder.swarm.example',
  hostname: 'qwen3-coder.swarm.example',
  enabled: true,
  status: 'VERIFIED_BY_THIS_ROUTER',
  lastCheckedAt: '2026-10-06T12:00:00.000Z',
  lastStage: null,
  lastReason: null,
  measurementSeen: TRUSTED_MEASUREMENT,
  measurementSource: 'REGISTRY',
  measurementInRegistry: true as boolean | null,
  evidenceDigestSeen: 'sha256/AAAABBBBCCCCDDDDEEEEFFFF',
  evidenceDigestSeenHex: '1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff',
  // Two-factor trust (SUP-252): the approved deployment is the one answering.
  pinnedEvidenceDigest: 'sha256/AAAABBBBCCCCDDDDEEEEFFFF' as string | null,
  pinnedEvidenceDigestHex: '1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff' as string | null,
  pinnedCertFingerprint: 'ffffeeeeddddccccbbbbaaaa000099998888777766665555444433332222111',
  apiKeyPrefix: 'sk-up-9f3a',
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-06T12:00:00.000Z',
  models: [
    {
      __typename: 'ExternalEndpointModel',
      id: 'qwen3-coder-30b:tdx',
      name: 'Qwen3 Coder 30B',
      upstreamModel: 'qwen3-coder-30b',
      contextLength: 131072,
      capabilities: ['CHAT'],
      pricing: { __typename: 'Pricing', promptPer1m: '600000', completionPer1m: '900000' },
    },
  ],
  latestEvidence: EVIDENCE,
  pinnedEvidence: EVIDENCE as typeof EVIDENCE | null,
  events: [
    {
      __typename: 'ExternalEndpointEvent',
      id: 'ext-evt-2',
      at: '2026-10-06T12:00:00.000Z',
      kind: 'DIGEST_CHANGED',
      stage: null,
      reason: null,
      measurement: TRUSTED_MEASUREMENT,
      evidenceDigest: 'sha256/AAAABBBBCCCCDDDDEEEEFFFF',
      evidenceDigestHex: '1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff',
      evidence: EVIDENCE,
    },
    {
      __typename: 'ExternalEndpointEvent',
      id: 'ext-evt-1',
      at: '2026-10-01T09:00:00.000Z',
      kind: 'REGISTERED',
      stage: null,
      reason: null,
      measurement: null,
      evidenceDigest: null,
      evidenceDigestHex: null,
      evidence: EVIDENCE,
    },
  ],
};

const DENIED_ENDPOINT = {
  ...VERIFIED_ENDPOINT,
  id: 'ext-2',
  name: 'gemma-2-2b',
  baseUrl: 'https://gemma.swarm.example',
  hostname: 'gemma.swarm.example',
  status: 'DENIED_BY_THIS_ROUTER',
  lastStage: 'policy',
  lastReason: 'measurement not on the trust list',
  measurementSeen: ROGUE_MEASUREMENT,
  measurementSource: 'OPERATOR_PINNED',
  pinnedCertFingerprint: null,
  apiKeyPrefix: 'sk-up-11bb',
  events: [
    {
      __typename: 'ExternalEndpointEvent',
      id: 'ext-evt-9',
      at: '2026-10-06T12:01:00.000Z',
      kind: 'DENIED_BY_THIS_ROUTER',
      stage: 'policy',
      reason: 'measurement not on the trust list',
      measurement: ROGUE_MEASUREMENT,
      evidenceDigest: null,
      evidence: null,
    },
  ],
};

const PENDING_ENDPOINT = {
  ...VERIFIED_ENDPOINT,
  id: 'ext-3',
  name: 'llama-3-2-3b',
  baseUrl: 'https://llama.swarm.example',
  hostname: 'llama.swarm.example',
  status: 'PENDING',
  lastCheckedAt: null,
  lastStage: null,
  lastReason: null,
  measurementSeen: null,
  measurementSource: null,
  measurementInRegistry: null,
  evidenceDigestSeen: null,
  evidenceDigestSeenHex: null,
  pinnedEvidenceDigest: null,
  pinnedEvidenceDigestHex: null,
  pinnedCertFingerprint: null,
  latestEvidence: null,
  pinnedEvidence: null,
  events: [],
};

export const ADMIN_OPERATIONS = {
  ExternalEndpoints: { externalEndpoints: [VERIFIED_ENDPOINT, DENIED_ENDPOINT, PENDING_ENDPOINT] },
  TrustedMeasurements: {
    trustedMeasurements: [
      {
        __typename: 'TrustedMeasurement',
        id: 'tm-1',
        measurement: TRUSTED_MEASUREMENT,
        note: 'Super Protocol production cloud',
        addedByEmail: 'developer@example.com',
        addedAt: '2026-09-30T08:00:00.000Z',
        admits: 2,
      },
      {
        __typename: 'TrustedMeasurement',
        id: 'tm-2',
        measurement: 'c'.repeat(64),
        note: null,
        addedByEmail: null,
        addedAt: '2026-10-02T08:00:00.000Z',
        admits: 0,
      },
    ],
  },
};

export { DENIED_ENDPOINT, PENDING_ENDPOINT, TRUSTED_MEASUREMENT, VERIFIED_ENDPOINT };
