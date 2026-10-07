import type { GateCheck, GateEvidence, GateResult } from './components/chat/verification/evidence-gate';
import type { VerificationState } from './components/chat/verification/use-verification';
import type {
  EndpointEvidenceFieldsFragment,
  EvidenceSnapshotFieldsFragment,
  ExternalUpstreamFieldsFragment,
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
    evidenceDigestHex: 'f579367d3d6942f03b05d138acbd1e426dd7913a59f2f35cd58b16b87809a00b',
    certFingerprint: 'sha256/PmQ7dR2xWvB9CkE5sM1fTnZ4aYh6UbLp0GjXoIeVwNs',
    certFingerprintHex: '3e643b751db15af07d0a4139b0cd5f4e767869887a51b2e9d068d7a08795c0db',
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
        fingerprint: 'sha256/OJ_Y8boMlSj9_dKFf9w8Si1muIFr6EAKgXCdgnEuwLA',
        fingerprintHex: '389fd8f1ba0c9528fdfdd2857fdc3c4a2d66b8816be8400a81709d82712ec0b0',
        isRoot: false,
      }),
      typed('CertSummary', {
        subject: 'CN=swarm-cloud-prod',
        issuer: 'CN=swarm-cloud-prod',
        notAfter: '2031-01-01T00:00:00.000Z',
        fingerprint: 'sha256/eN7J30KqI96yWxc5VLOpL5VPQYyBKAA2K3HhPBIBXgg',
        fingerprintHex: '78dec9df42aa23deb25b173954b3a92f954f418c812800362b71e13c12015e08',
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
    declaredImages: DECLARED_IMAGES.map((image) => typed('DeclaredImage', image)),
    latestEvidence: evidenceSnapshot(),
    ...overrides,
  });
}

/**
 * The allow-list the demo deployment declares, matching the digests of
 * {@link SIGNED_SNAPSHOT} — so the default fixtures render the case the panel is
 * supposed to render most of the time: every image declared.
 */
export const DECLARED_IMAGES: { name: string; digest: string }[] = [
  {
    name: 'ghcr.io/super-protocol/router-api',
    digest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
  },
  {
    name: 'ghcr.io/berriai/litellm',
    digest: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
  },
  {
    name: 'ghcr.io/super-protocol/router-ui',
    digest: 'sha256:3333333333333333333333333333333333333333333333333333333333333333',
  },
];

/**
 * A deployment snapshot in the shape the live platform signs: full Kubernetes
 * documents under `{ version: 2, resources }`, with pods and `status` stripped by
 * swarm-cloud's canonicalisation rules, an Ingress routing two hosts, two
 * Deployments a Service each selects, and a Secret and ConfigMap the graph names
 * but does not draw.
 */
export const SIGNED_SNAPSHOT = {
  version: 2,
  resources: [
    {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'litellm-config', namespace: 'confidential-router' },
      data: { 'config.yaml': 'model_list: []' },
    },
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'litellm', namespace: 'confidential-router' },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: 'litellm' } },
        template: {
          metadata: { labels: { app: 'litellm' } },
          spec: {
            containers: [
              {
                name: 'litellm',
                image:
                  'ghcr.io/berriai/litellm@sha256:2222222222222222222222222222222222222222222222222222222222222222',
                ports: [{ containerPort: 4000 }],
              },
            ],
          },
        },
      },
    },
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'router-api', namespace: 'confidential-router' },
      spec: {
        replicas: 2,
        selector: { matchLabels: { app: 'router-api' } },
        template: {
          metadata: { labels: { app: 'router-api' } },
          spec: {
            initContainers: [
              {
                name: 'migrate',
                image:
                  'ghcr.io/super-protocol/router-api@sha256:1111111111111111111111111111111111111111111111111111111111111111',
                command: ['node', 'migrate.js'],
              },
            ],
            containers: [
              {
                name: 'router-api',
                image:
                  'ghcr.io/super-protocol/router-api@sha256:1111111111111111111111111111111111111111111111111111111111111111',
                ports: [{ containerPort: 3000 }],
              },
            ],
          },
        },
      },
    },
    {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'Ingress',
      metadata: { name: 'router', namespace: 'confidential-router' },
      spec: {
        tls: [{ hosts: ['llama-33-70b.tee.swarm.cloud', 'console.tee.swarm.cloud'], secretName: 'router-tls' }],
        rules: [
          {
            host: 'llama-33-70b.tee.swarm.cloud',
            http: { paths: [{ path: '/v1', pathType: 'Prefix', backend: { service: { name: 'router-api' } } }] },
          },
          {
            host: 'console.tee.swarm.cloud',
            http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'router-ui' } } }] },
          },
        ],
      },
    },
    {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 'router-tls', namespace: 'confidential-router' },
      type: 'kubernetes.io/tls',
    },
    {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: 'litellm', namespace: 'confidential-router' },
      spec: { type: 'ClusterIP', selector: { app: 'litellm' }, ports: [{ port: 4000 }] },
    },
    {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: 'router-api', namespace: 'confidential-router' },
      spec: { type: 'ClusterIP', selector: { app: 'router-api' }, ports: [{ port: 3000 }] },
    },
    {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: 'router-ui', namespace: 'confidential-router' },
      spec: { type: 'ClusterIP', selector: { app: 'router-ui' }, ports: [{ port: 4300 }] },
    },
    {
      apiVersion: 'apps/v1',
      kind: 'StatefulSet',
      metadata: { name: 'router-ui', namespace: 'confidential-router' },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: 'router-ui' } },
        template: {
          metadata: { labels: { app: 'router-ui' } },
          spec: {
            containers: [
              {
                name: 'router-ui',
                image:
                  'ghcr.io/super-protocol/router-ui@sha256:3333333333333333333333333333333333333333333333333333333333333333',
              },
            ],
          },
        },
      },
    },
  ],
};

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
      evidenceDigestHex: '29df2c0789d1db062f4fac5098bd1a65cf447f52615291a2dcdad7a157926c0a',
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

/**
 * An upstream this router has verified, as the catalogue hands it over to a
 * signed-in reader.
 *
 * The hostname is deliberately in somebody else's namespace: every fixture host
 * above is `*.tee.swarm.cloud`, this deployment's own, and a test that confuses
 * the two vocabularies should read wrong at a glance.
 */
export function verifiedUpstream(
  overrides: Partial<ExternalUpstreamFieldsFragment> = {},
): ExternalUpstreamFieldsFragment {
  return typed('ExternalUpstream', {
    id: 'ext-1',
    name: 'partner-cloud',
    hostname: 'llama-33-70b.partner.example',
    status: 'VERIFIED_BY_THIS_ROUTER' as const,
    lastCheckedAt: '2026-10-06T11:58:00.000Z',
    measurementSeen: 'a'.repeat(64),
    evidenceDigestSeen: 'sha256/Qd4sB7nR1wYvT9xQmL2aZc3Ef5JhUpGi7NrXoVeSbAo',
    ...overrides,
  });
}

type CatalogueModelFixture = ModelCatalogueQuery['models'][number];

/** A model in this deployment's own cluster space. */
function configModel(
  overrides: Partial<CatalogueModelFixture> & Pick<CatalogueModelFixture, 'id'>,
): CatalogueModelFixture {
  return typed('Model', {
    slug: overrides.id,
    name: 'Llama 3.3 70B Instruct',
    contextLength: 128_000,
    tee: 'Intel TDX + H100 CC',
    origin: 'CONFIG' as const,
    available: true,
    pricing: typed('Pricing', { promptPer1m: '280000', completionPer1m: '420000' }),
    endpoint: publishedEndpoint(),
    externalUpstream: null,
    ...overrides,
  });
}

/**
 * A model on an external endpoint, with the two fields a config row has filled
 * in the other way round: no `endpoint`, an `externalUpstream`.
 *
 * Pass `externalUpstream: null` for the anonymous reader's view of the same row
 * (SUP-221 ruling 3) — name, price and `available`, and no verdict detail.
 */
export function externalModel(overrides: Partial<CatalogueModelFixture> = {}): CatalogueModelFixture {
  const id = overrides.id ?? 'partner/llama-3.3-70b:snp';
  return typed('Model', {
    id,
    slug: id,
    name: 'Llama 3.3 70B (partner)',
    contextLength: 128_000,
    tee: null,
    origin: 'EXTERNAL' as const,
    available: true,
    pricing: typed('Pricing', { promptPer1m: '400000', completionPer1m: '800000' }),
    endpoint: null,
    externalUpstream: verifiedUpstream(),
    ...overrides,
  });
}

export function catalogueData(overrides: Partial<ModelCatalogueQuery> = {}): ModelCatalogueQuery {
  return {
    models: [
      configModel({ id: 'meta/llama-3.3-70b-instruct:tdx' }),
      configModel({
        id: 'alibaba/qwen2.5-72b-instruct:snp',
        name: 'Qwen2.5 72B Instruct',
        tee: 'AMD SEV-SNP',
        pricing: typed('Pricing', { promptPer1m: '240000', completionPer1m: '360000' }),
        endpoint: unpublishedEndpoint(),
      }),
    ],
    ...overrides,
  };
}

/** The hostname the attestation fixtures describe. */
export const INSPECTED_HOSTNAME = 'llama-33-70b.tee.swarm.cloud';

/**
 * A tier-1 result in which every blocking check passed and the root check is
 * what the live platform leaves it: not established, because the registry
 * indexes a measurement a browser cannot rebuild.
 */
export const PASSING_GATE_CHECKS: GateCheck[] = [
  { id: 'bundle', status: 'pass', detail: 'The host served a swarm-evidence v1 bundle.' },
  { id: 'chain', status: 'pass', detail: 'Each certificate signs the next.' },
  { id: 'signature', status: 'pass', detail: 'The evidence is signed by the key in the chain leaf.' },
  { id: 'freshness', status: 'pass', detail: 'Signed 2 minutes ago.' },
  { id: 'binding', status: 'pass', detail: 'The published TLS certificate hashes to the signed fingerprint.' },
  { id: 'root', status: 'unavailable', detail: 'The registry indexes a launch measurement rebuilt from firmware.' },
];

/**
 * `GateEvidence` as the live platform's bundle produces it: a real SEV-SNP root
 * report with its policy and TCB fields, a producer-asserted channel binding, no
 * usable `rootCaTeeQuote`, and {@link SIGNED_SNAPSHOT} as the signed snapshot.
 *
 * Shared between the inspector's component tests and the `/dev/attestation`
 * review surface the e2e accessibility pass audits, so the thing being tested and
 * the thing being audited are the same panel over the same document.
 */
export function gateEvidence(overrides: Partial<GateEvidence> = {}): GateEvidence {
  return {
    hostname: INSPECTED_HOSTNAME,
    source: 'endpoint',
    issuedAt: '2026-10-01T09:28:00.000Z',
    kind: 'DeploymentEvidence',
    evidenceDigest: 'sha256/9Xk2fT1pQvA7BdE4rL0eQm3XkTpZ8vNc1YsWuHgJoAs',
    certFingerprint: 'sha256/PmQ7dR2xWvB9CkE5sM1fTnZ4aYh6UbLp0GjXoIeVwNs',
    snapshot: SIGNED_SNAPSHOT,
    jws: 'eyJhbGciOiJSUzI1NiJ9.eyJpc3N1ZWRBdCI6MX0.c2lnbmF0dXJl',
    chain: [
      {
        subject: `CN=${INSPECTED_HOSTNAME}`,
        issuer: 'CN=Swarm PKI Subroot',
        notBefore: '2026-09-01T00:00:00.000Z',
        notAfter: '2026-11-29T00:00:00.000Z',
        fingerprint: 'sha256/OJ_Y8boMlSj9_dKFf9w8Si1muIFr6EAKgXCdgnEuwLA',
        isRoot: false,
      },
      {
        subject: 'CN=Super Swarm Root CA',
        issuer: 'CN=Super Swarm Root CA',
        notBefore: '2026-01-01T00:00:00.000Z',
        notAfter: '2031-01-01T00:00:00.000Z',
        fingerprint: 'sha256/eN7J30KqI96yWxc5VLOpL5VPQYyBKAA2K3HhPBIBXgg',
        isRoot: true,
      },
    ],
    rootSubject: 'CN=Super Swarm Root CA',
    rootFingerprint: 'sha256/eN7J30KqI96yWxc5VLOpL5VPQYyBKAA2K3HhPBIBXgg',
    quoteFormat: null,
    measurement: null,
    rootEvidenceLabel: 'AMD SEV-SNP (QEMU)',
    rootBuild: 'build-370',
    rootKeyBinding: true,
    rootNetworkType: 'untrusted',
    rootEvidenceType: 'sev-snp-qemu',
    rootChallengeType: 'sev-snp',
    rootReportMeasurement:
      'ad175671b4c2f3929ecb8e6b0b37765cf90a82071e8b53f2df8730e0d68af60ba4513b26503bc63cd5d82e997363c424',
    rootSecurity: {
      reportVersion: 5,
      guestSvn: 0,
      vmpl: 0,
      policy: {
        raw: '0x30000',
        abiMajor: 0,
        abiMinor: 0,
        smtAllowed: true,
        migrateMaAllowed: false,
        debugAllowed: false,
        singleSocketRequired: false,
        ciphertextHiding: false,
        pageSwapDisabled: false,
      },
      launchTcb: { raw: '0x581b00000000000a', bootLoader: 10, tee: 0, snp: 27, microcode: 88 },
      currentTcb: { raw: '0x581b00000000000a', bootLoader: 10, tee: 0, snp: 27, microcode: 88 },
      reportedTcb: { raw: '0x581b00000000000a', bootLoader: 10, tee: 0, snp: 27, microcode: 88 },
    },
    rootAttestationError: null,
    ...overrides,
  };
}

/** The chat's verification state, passing, for the inspector's props. */
export function verificationState(overrides: Partial<VerificationState> = {}): VerificationState {
  const gate: GateResult = { unlocked: true, checks: PASSING_GATE_CHECKS, registry: null, evidence: gateEvidence() };
  return {
    gate,
    checkedAt: new Date('2026-10-01T09:30:00.000Z'),
    extension: null,
    pageState: 'pass',
    extensionState: 'unavailable',
    unlocked: true,
    recheck: () => undefined,
    ...overrides,
  };
}
