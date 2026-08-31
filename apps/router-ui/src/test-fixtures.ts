import type {
  EndpointEvidenceFieldsFragment,
  EvidenceSnapshotFieldsFragment,
  ModelCatalogueQuery,
  OverviewQuery,
} from './generated/graphql';

/**
 * Stamps the `__typename` a mocked response has to carry.
 *
 * The generated result types leave `__typename` out, but Apollo adds it to every
 * document it sends and `InMemoryCache` needs it to decide whether
 * `...EndpointEvidenceFields` applies to an object. Without it the cache reads
 * an endpoint back with only its non-fragment fields, which fails far from the
 * fixture that caused it. The cast is what keeps the extra key out of the
 * generated types' business.
 */
function typed<T>(__typename: string, value: T): T {
  return { __typename, ...value } as T;
}

/**
 * Fixtures shaped like what router-api returns, for the screens' component
 * tests. They carry the three publication states the console has to render, and
 * a bundle with the measurement registers an Intel TDX + H100 producer publishes.
 */
export function evidenceSnapshot(
  overrides: Partial<EvidenceSnapshotFieldsFragment> = {},
): EvidenceSnapshotFieldsFragment {
  return typed('EvidenceSnapshot', {
    id: 'snap-1',
    endpointId: 'ep-1',
    issuedAt: '2026-08-31T09:28:00.000Z',
    fetchedAt: '2026-08-31T09:28:12.000Z',
    quoteAgeSeconds: 12,
    quoteFormat: 'intel-tdx-quote-v5',
    evidenceDigest: 'sha256/9Xk2fT1pQvA7BdE4rL0eQm3XkTpZ8vNc1YsWuHgJoAs',
    evidenceDigestHex: 'f5793a7d4ec1',
    certFingerprint: 'sha256/PmQ7dR2xWvB9CkE5sM1fTnZ4aYh6UbLp0GjXoIeVwNs',
    containerImages: ['vllm-tdx@sha256:6b1f9c04'],
    jws: 'eyJhbGciOiJSUzI1NiJ9.eyJpc3N1ZWRBdCI6MX0.c2lnbmF0dXJl',
    measurements: [
      typed('Measurement', { name: 'MRTD', value: '91f4a27c8bd0e5137ac64e0b9d' }),
      typed('Measurement', { name: 'RTMR0', value: 'c3a71e05f9db2846bb1407f2ac' }),
      typed('Measurement', { name: 'GPU', value: 'H100 CC-mode driver quote 550.90' }),
    ],
    chain: [
      typed('CertSummary', {
        subject: 'CN=llama-33-70b.tee.swarm.cloud',
        issuer: 'CN=swarm-pki-subroot',
        notAfter: '2026-11-29T00:00:00.000Z',
        fingerprint: 'sha256/leafleafleafleafleafleaf',
        isRoot: false,
      }),
      typed('CertSummary', {
        subject: 'CN=swarm-cloud-prod',
        issuer: 'CN=swarm-cloud-prod',
        notAfter: '2031-01-01T00:00:00.000Z',
        fingerprint: 'sha256/rootrootrootrootrootroot',
        isRoot: true,
      }),
    ],
    ...overrides,
  });
}

export function publishedEndpoint(
  overrides: Partial<EndpointEvidenceFieldsFragment> = {},
): EndpointEvidenceFieldsFragment {
  return typed('Endpoint', {
    id: 'ep-1',
    name: 'Llama 3.3 70B',
    hostname: 'llama-33-70b.tee.swarm.cloud',
    tee: 'Intel TDX + H100 CC',
    evidenceState: 'PUBLISHED' as const,
    latestEvidence: evidenceSnapshot(),
    ...overrides,
  });
}

/** The prototype's "signing key rotating" endpoint: a bundle, but a stale one. */
export function rotatingEndpoint(
  overrides: Partial<EndpointEvidenceFieldsFragment> = {},
): EndpointEvidenceFieldsFragment {
  return publishedEndpoint({
    id: 'ep-2',
    name: 'DeepSeek-V3',
    hostname: 'deepseek-v3.tee.swarm.cloud',
    evidenceState: 'STALE',
    latestEvidence: evidenceSnapshot({
      id: 'snap-2',
      endpointId: 'ep-2',
      quoteAgeSeconds: 740,
      evidenceDigest: 'sha256/Kd8sB4nR2wYvT6xQmL0aZc9Ef1JhUpGi3NrXoVeSbAo',
    }),
    ...overrides,
  });
}

export function unpublishedEndpoint(
  overrides: Partial<EndpointEvidenceFieldsFragment> = {},
): EndpointEvidenceFieldsFragment {
  return publishedEndpoint({
    id: 'ep-3',
    name: 'Qwen2.5 72B',
    hostname: 'qwen25-72b.tee.swarm.cloud',
    tee: 'AMD SEV-SNP',
    evidenceState: 'NOT_PUBLISHED',
    latestEvidence: null,
    ...overrides,
  });
}

export function overviewData(overrides: Partial<OverviewQuery> = {}): OverviewQuery {
  return {
    activitySummary: typed('ActivitySummary', {
      spendMicros: '149340000',
      requests: 10_900,
      promptTokens: 700_000_000,
      completionTokens: 80_300_000,
      coveredRequests: 10_900,
      evidenceCoverage: 1,
    }),
    activitySeries: [
      dayPoint('2026-08-25T00:00:00.000Z', 1),
      dayPoint('2026-08-26T00:00:00.000Z', 2),
      dayPoint('2026-08-27T00:00:00.000Z', 9),
      dayPoint('2026-08-28T00:00:00.000Z', 7),
      dayPoint('2026-08-29T00:00:00.000Z', 5),
      dayPoint('2026-08-30T00:00:00.000Z', 0),
      dayPoint('2026-08-31T00:00:00.000Z', 0),
    ],
    endpoints: [
      { ...publishedEndpoint(), tokensRouted30d: 598_000_000 },
      { ...rotatingEndpoint(), tokensRouted30d: 340_000 },
    ],
    ...overrides,
  };
}

function dayPoint(bucket: string, weight: number): OverviewQuery['activitySeries'][number] {
  return typed('ActivityPoint', {
    bucket,
    spendMicros: String(weight * 1_000_000),
    requests: weight * 100,
    promptTokens: weight * 10_000,
    completionTokens: weight * 1000,
  });
}

export function catalogueData(overrides: Partial<ModelCatalogueQuery> = {}): ModelCatalogueQuery {
  return {
    models: [
      typed('Model', {
        id: 'meta/llama-3.3-70b-instruct:tdx',
        slug: 'meta/llama-3.3-70b-instruct:tdx',
        name: 'Llama 3.3 70B Instruct',
        contextLength: 128_000,
        tee: 'Intel TDX + H100 CC',
        pricing: typed('Pricing', { promptPer1m: '280000', completionPer1m: '420000' }),
        endpoint: publishedEndpoint(),
      }),
      typed('Model', {
        id: 'alibaba/qwen2.5-72b-instruct:snp',
        slug: 'alibaba/qwen2.5-72b-instruct:snp',
        name: 'Qwen2.5 72B Instruct',
        contextLength: 128_000,
        tee: 'AMD SEV-SNP',
        pricing: typed('Pricing', { promptPer1m: '240000', completionPer1m: '360000' }),
        endpoint: unpublishedEndpoint(),
      }),
    ],
    ...overrides,
  };
}
