import type { MockLink } from '@apollo/client/testing';
import {
  DISCOVER_EXTERNAL_MODELS,
  EXTERNAL_ENDPOINT_VERDICT_QUERY,
  EXTERNAL_ENDPOINTS_QUERY,
  TRUSTED_MEASUREMENTS_QUERY,
} from './operations';

/** The deployment an admin approved, and the one a redeploy brought in (SUP-252). */
export const DIGEST_APPROVED = 'sha256/AAAABBBBCCCCDDDD';
export const DIGEST_APPROVED_HEX = '1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff';
export const DIGEST_REDEPLOYED = 'sha256/EEEEFFFF99998888';
export const DIGEST_REDEPLOYED_HEX = '9999888877776666555544443333222211110000ffffeeeeddddccccbbbbaaaa';

/**
 * Fixtures for the admin screens.
 *
 * `__typename` on every object: Apollo's cache adds it to each selection set, so
 * a mock without it writes a row the cache then reads back as incomplete and the
 * screen renders a loading state forever.
 */

export const MEASUREMENT_TRUSTED = 'a'.repeat(64);
export const MEASUREMENT_ROGUE = 'b'.repeat(64);

export const EVIDENCE = {
  __typename: 'ExternalEndpointEvidence' as const,
  snapshotId: 'snap-1',
  fetchedAt: '2026-10-06T11:58:00.000Z',
  issuedAt: '2026-10-06T11:50:00.000Z',
  evidenceDigest: 'sha256/AAAABBBBCCCCDDDD',
  evidenceDigestHex: '1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff',
  certFingerprint: 'sha256/EEEEFFFF00001111',
  certFingerprintHex: 'ffffeeeeddddccccbbbbaaaa00009999888877776666555544443333222211110',
  quoteFormat: 'intel-tdx-quote-v5',
  containerImages: [
    'ghcr.io/example/vllm@sha256:1111111111111111111111111111111111111111111111111111111111111111',
    'ghcr.io/example/sidecar@sha256:2222222222222222222222222222222222222222222222222222222222222222',
  ],
  workloads: [
    {
      __typename: 'EvidenceWorkload' as const,
      kind: 'Deployment',
      name: 'vllm',
      namespace: 'qwen3-coder',
      containers: ['vllm', 'init-weights'],
    },
    {
      __typename: 'EvidenceWorkload' as const,
      kind: 'StatefulSet',
      name: 'cache',
      namespace: 'qwen3-coder',
      containers: ['redis'],
    },
  ],
  measurements: [{ __typename: 'Measurement' as const, name: 'MRTD', value: 'abc123' }],
};

/** A second snapshot, so a `DIGEST_CHANGED` event shows a different image. */
export const EVIDENCE_AFTER_CHANGE = {
  ...EVIDENCE,
  snapshotId: 'snap-2',
  containerImages: ['ghcr.io/example/vllm@sha256:3333333333333333333333333333333333333333333333333333333333333333'],
};

export const VERIFIED_ENDPOINT = {
  __typename: 'ExternalEndpoint' as const,
  id: 'ext-1',
  name: 'qwen3-coder',
  baseUrl: 'https://qwen3-coder.swarm.example',
  hostname: 'qwen3-coder.swarm.example',
  enabled: true,
  status: 'VERIFIED_BY_THIS_ROUTER' as const,
  lastCheckedAt: '2026-10-06T12:00:00.000Z',
  lastStage: null,
  lastReason: null,
  measurementSeen: MEASUREMENT_TRUSTED,
  measurementSource: 'REGISTRY' as const,
  measurementInRegistry: true,
  evidenceDigestSeen: DIGEST_APPROVED,
  evidenceDigestSeenHex: DIGEST_APPROVED_HEX,
  pinnedEvidenceDigest: DIGEST_APPROVED as string | null,
  pinnedEvidenceDigestHex: DIGEST_APPROVED_HEX as string | null,
  pinnedCertFingerprint: 'ffffeeeeddddccccbbbbaaaa00009999888877776666555544443333222211110',
  apiKeyPrefix: 'sk-up-9f3a',
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-06T12:00:00.000Z',
  models: [
    {
      __typename: 'ExternalEndpointModel' as const,
      id: 'qwen3-coder-30b:tdx',
      name: 'Qwen3 Coder 30B',
      upstreamModel: 'qwen3-coder-30b',
      contextLength: 131072,
      capabilities: ['CHAT' as const],
      pricing: { __typename: 'Pricing' as const, promptPer1m: '600000', completionPer1m: '900000' },
    },
  ],
  latestEvidence: EVIDENCE,
  pinnedEvidence: EVIDENCE as typeof EVIDENCE | null,
  events: [
    {
      __typename: 'ExternalEndpointEvent' as const,
      id: 'evt-3',
      at: '2026-10-06T12:00:00.000Z',
      kind: 'DIGEST_CHANGED' as const,
      stage: null,
      reason: null,
      measurement: MEASUREMENT_TRUSTED,
      evidenceDigest: 'sha256/AAAABBBBCCCCDDDD',
      evidence: EVIDENCE_AFTER_CHANGE,
    },
    {
      __typename: 'ExternalEndpointEvent' as const,
      id: 'evt-2',
      at: '2026-10-01T09:05:00.000Z',
      kind: 'VERIFIED_BY_THIS_ROUTER' as const,
      stage: null,
      reason: null,
      measurement: MEASUREMENT_TRUSTED,
      evidenceDigest: 'sha256/AAAABBBBCCCCDDDD',
      evidence: null,
    },
    {
      __typename: 'ExternalEndpointEvent' as const,
      id: 'evt-1',
      at: '2026-10-01T09:00:00.000Z',
      kind: 'REGISTERED' as const,
      stage: null,
      reason: null,
      measurement: null,
      evidenceDigest: null,
      evidence: EVIDENCE,
    },
  ],
};

export const DENIED_ENDPOINT = {
  ...VERIFIED_ENDPOINT,
  id: 'ext-2',
  name: 'gemma-2-2b',
  baseUrl: 'https://gemma.swarm.example',
  hostname: 'gemma.swarm.example',
  status: 'DENIED_BY_THIS_ROUTER' as const,
  lastStage: 'policy',
  lastReason: 'measurement not on the trust list',
  measurementSeen: MEASUREMENT_ROGUE,
  measurementSource: 'OPERATOR_PINNED' as const,
  measurementInRegistry: false,
  pinnedCertFingerprint: null,
  apiKeyPrefix: 'sk-up-11bb',
  latestEvidence: EVIDENCE,
  events: [
    {
      __typename: 'ExternalEndpointEvent' as const,
      id: 'evt-10',
      at: '2026-10-06T12:01:00.000Z',
      kind: 'DENIED_BY_THIS_ROUTER' as const,
      stage: 'policy',
      reason: 'measurement not on the trust list',
      measurement: MEASUREMENT_ROGUE,
      evidenceDigest: null,
      evidence: null,
    },
  ],
};

export const PENDING_ENDPOINT = {
  ...VERIFIED_ENDPOINT,
  id: 'ext-3',
  name: 'llama-3-2-3b',
  baseUrl: 'https://llama.swarm.example',
  hostname: 'llama.swarm.example',
  status: 'PENDING' as const,
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

/**
 * Registered and checked once: both factors seen, neither approved yet. The first
 * screen of the TOFU-with-approval loop (SUP-252).
 */
export const AWAITING_APPROVAL_ENDPOINT = {
  ...PENDING_ENDPOINT,
  id: 'ext-5',
  name: 'llama-demo',
  baseUrl: 'https://llama-demo.swarm.example',
  hostname: 'llama-demo.swarm.example',
  lastCheckedAt: '2026-10-08T14:00:00.000Z',
  lastStage: 'digest-not-pinned',
  lastReason: 'no evidenceDigest is pinned for endpoint "llama-demo"',
  measurementSeen: MEASUREMENT_ROGUE,
  measurementSource: 'REGISTRY' as const,
  measurementInRegistry: true,
  evidenceDigestSeen: DIGEST_APPROVED,
  evidenceDigestSeenHex: DIGEST_APPROVED_HEX,
  latestEvidence: EVIDENCE,
};

/** The trusted cloud is unchanged and the upstream redeployed: failed closed at `digest-mismatch`. */
export const REDEPLOYED_ENDPOINT = {
  ...VERIFIED_ENDPOINT,
  id: 'ext-6',
  name: 'llama-redeployed',
  status: 'DENIED_BY_THIS_ROUTER' as const,
  lastStage: 'digest-mismatch',
  lastReason: 'the deployment now publishes a different evidenceDigest',
  pinnedCertFingerprint: null,
  evidenceDigestSeen: DIGEST_REDEPLOYED,
  evidenceDigestSeenHex: DIGEST_REDEPLOYED_HEX,
  latestEvidence: {
    ...EVIDENCE_AFTER_CHANGE,
    evidenceDigest: DIGEST_REDEPLOYED,
    evidenceDigestHex: DIGEST_REDEPLOYED_HEX,
  },
  pinnedEvidence: EVIDENCE,
  events: [],
};

export const DISABLED_ENDPOINT = {
  ...VERIFIED_ENDPOINT,
  id: 'ext-4',
  name: 'retired-upstream',
  baseUrl: 'https://retired.swarm.example',
  hostname: 'retired.swarm.example',
  enabled: false,
  status: 'DISABLED' as const,
  events: [],
};

export const ALL_ENDPOINTS = [VERIFIED_ENDPOINT, DENIED_ENDPOINT, PENDING_ENDPOINT, DISABLED_ENDPOINT];

export function endpointsMock(endpoints: unknown[] = ALL_ENDPOINTS): MockLink.MockedResponse {
  return {
    request: { query: EXTERNAL_ENDPOINTS_QUERY },
    result: { data: { externalEndpoints: endpoints } },
    // `cache-and-network` plus the post-mutation refetch ask more than once.
    maxUsageCount: Number.POSITIVE_INFINITY,
  };
}

export const TRUSTED = {
  __typename: 'TrustedMeasurement' as const,
  id: 'tm-1',
  measurement: MEASUREMENT_TRUSTED,
  note: 'Super Protocol production cloud',
  addedByEmail: 'admin@example.com',
  addedAt: '2026-09-30T08:00:00.000Z',
  admits: 2,
};

export const TRUSTED_UNUSED = {
  ...TRUSTED,
  id: 'tm-2',
  measurement: 'c'.repeat(64),
  note: null,
  addedByEmail: null,
  admits: 0,
};

export function measurementsMock(measurements: unknown[] = [TRUSTED, TRUSTED_UNUSED]): MockLink.MockedResponse {
  return {
    request: { query: TRUSTED_MEASUREMENTS_QUERY },
    result: { data: { trustedMeasurements: measurements } },
    maxUsageCount: Number.POSITIVE_INFINITY,
  };
}

/** The register dialog's verdict poll (SUP-249). Unbounded: the panel polls until it closes. */
export function verdictMock(
  id: string,
  status: 'PENDING' | 'VERIFIED_BY_THIS_ROUTER' | 'DENIED_BY_THIS_ROUTER' | 'DISABLED',
  overrides: Record<string, unknown> = {},
): MockLink.MockedResponse {
  return {
    request: { query: EXTERNAL_ENDPOINT_VERDICT_QUERY, variables: { id } },
    result: {
      data: {
        externalEndpoint: {
          __typename: 'ExternalEndpoint',
          id,
          status,
          lastCheckedAt: status === 'PENDING' ? null : '2026-10-08T10:00:00.000Z',
          lastStage: null,
          lastReason: null,
          measurementSeen: status === 'PENDING' ? null : MEASUREMENT_TRUSTED,
          measurementSource: status === 'PENDING' ? null : 'REGISTRY',
          measurementInRegistry: status === 'PENDING' ? null : true,
          evidenceDigestSeen: status === 'PENDING' ? null : DIGEST_APPROVED,
          evidenceDigestSeenHex: status === 'PENDING' ? null : DIGEST_APPROVED_HEX,
          pinnedEvidenceDigest: status === 'VERIFIED_BY_THIS_ROUTER' ? DIGEST_APPROVED : null,
          pinnedEvidenceDigestHex: status === 'VERIFIED_BY_THIS_ROUTER' ? DIGEST_APPROVED_HEX : null,
          pinnedCertFingerprint: status === 'VERIFIED_BY_THIS_ROUTER' ? 'ab'.repeat(32) : null,
          models: [],
          ...overrides,
        },
      },
    },
    maxUsageCount: Number.POSITIVE_INFINITY,
  };
}

export function discoverMock(id: string, models: Record<string, unknown>[]): MockLink.MockedResponse {
  return {
    request: { query: DISCOVER_EXTERNAL_MODELS, variables: { id } },
    result: {
      data: {
        discoverExternalModels: models.map((model) => ({
          __typename: 'DiscoveredExternalModel',
          name: null,
          contextLength: null,
          promptPer1mMicros: null,
          completionPer1mMicros: null,
          registeredAs: null,
          ...model,
        })),
      },
    },
  };
}
