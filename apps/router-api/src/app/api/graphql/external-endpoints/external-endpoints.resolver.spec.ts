import type { ConfigType } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { SessionUser, UserProfileService } from '../../../auth/index.js';
import type { routerConfig } from '../../../config.js';
import { RouterConfigSchema } from '../../../config.schema.js';
import type { EvidenceSnapshot } from '../../../db/entities/evidence-snapshot.entity.js';
import { ExternalEndpoint } from '../../../db/entities/external-endpoint.entity.js';
import type { ExternalEndpointEvent } from '../../../db/entities/external-endpoint-event.entity.js';
import { Model } from '../../../db/entities/model.entity.js';
import { TrustedMeasurement } from '../../../db/entities/trusted-measurement.entity.js';
import type {
  ExternalEndpointAdminService,
  ExternalEndpointView,
  ExternalEvidenceService,
  ExternalModelDiscoveryService,
} from '../../../external-endpoints/index.js';
import { ExternalEndpointsResolver } from './external-endpoints.resolver.js';

const ADMIN: SessionUser = { id: 'admin-1', email: 'ops@example.test', name: 'Ops', image: null };
const MEMBER: SessionUser = { id: 'member-1', email: 'user@example.test', name: 'User', image: null };
const MEASUREMENT = 'a'.repeat(64);
const UPSTREAM_KEY = 'sk-upstream-super-secret-value';
const NOW = new Date('2026-10-06T12:00:00.000Z');
/** Real 32-byte digests, so `fingerprintHex` has something it will actually re-spell. */
const DIGEST_NOW = `sha256/${Buffer.alloc(32, 1).toString('base64url')}`;
const DIGEST_BEFORE = `sha256/${Buffer.alloc(32, 2).toString('base64url')}`;
const LEAF = `sha256/${Buffer.alloc(32, 3).toString('base64url')}`;

function config(adminEmails = 'ops@example.test'): ConfigType<typeof routerConfig> {
  return RouterConfigSchema.parse({
    auth: { secret: 'a'.repeat(32), adminEmails: [adminEmails] },
  }) as ConfigType<typeof routerConfig>;
}

function model(overrides: Partial<Model> = {}): Model {
  return {
    id: 'partner/llama:snp',
    name: 'Llama (partner)',
    litellmModel: 'llama-3.3-70b-instruct',
    origin: 'external',
    endpointId: null,
    externalEndpointId: 'ep-1',
    contextLength: 131_072,
    capabilities: ['chat'],
    promptPer1mMicros: 400_000,
    completionPer1mMicros: 800_000,
    tee: '',
    enabled: true,
    updatedAt: NOW,
    ...overrides,
  } as Model;
}

function view(endpoint: Partial<ExternalEndpoint> = {}, models: Model[] = [model()]): ExternalEndpointView {
  return {
    endpoint: {
      id: 'ep-1',
      name: 'partner-cloud',
      baseUrl: 'https://partner.example',
      hostname: 'partner.example',
      listenPort: 19_000,
      enabled: true,
      status: 'verified',
      lastCheckedAt: NOW,
      lastStage: null,
      lastReason: null,
      measurementSeen: MEASUREMENT,
      measurementSource: 'operator-pinned',
      measurementInRegistry: false,
      evidenceDigestSeen: DIGEST_NOW,
      pinnedCertFingerprint: LEAF,
      apiKeyCiphertext: `v1.${Buffer.from(UPSTREAM_KEY).toString('base64url')}`,
      apiKeyPrefix: 'sk-upstr',
      createdByUserId: 'admin-1',
      createdAt: NOW,
      updatedAt: NOW,
      ...endpoint,
    } as ExternalEndpoint,
    models,
  };
}

function event(overrides: Partial<ExternalEndpointEvent> = {}): ExternalEndpointEvent {
  return {
    id: 'evt-1',
    externalEndpointId: 'ep-1',
    at: NOW,
    kind: 'verified',
    stage: null,
    reason: null,
    measurement: MEASUREMENT,
    evidenceDigest: DIGEST_NOW,
    ...overrides,
  } as ExternalEndpointEvent;
}

function snapshot(id: string, evidenceDigest: string): EvidenceSnapshot {
  return {
    id,
    endpointId: null,
    externalEndpointId: 'ep-1',
    fetchedAt: NOW,
    issuedAt: NOW,
    evidenceDigest,
    evidenceDigestHex: 'f'.repeat(64),
    certFingerprint: LEAF,
    quoteFormat: 'intel-tdx-quote-v5',
    containerImages: [`ghcr.io/example/vllm@sha256:${id}`],
    chainSummary: [],
    workloads: [{ kind: 'Deployment', name: 'vllm', namespace: 'partner', containers: ['vllm'] }],
    measurements: { MRTD: 'abc123' },
    jws: 'a.b.c',
    bundle: {},
  } as EvidenceSnapshot;
}

function measurement(): TrustedMeasurement {
  return {
    id: 'tm-1',
    measurement: MEASUREMENT,
    note: 'Partner cloud',
    addedByUserId: 'admin-1',
    addedAt: NOW,
  };
}

interface Stubs {
  admin?: Partial<ExternalEndpointAdminService>;
  evidence?: Partial<ExternalEvidenceService>;
  adminEmails?: string;
}

function build({ admin: adminOverrides = {}, evidence: evidenceOverrides = {}, adminEmails }: Stubs = {}) {
  // Stubbed rather than seeded: Better Auth owns the `user` table and creates it
  // with its own migration, so a unit spec has none to read. It also lets the
  // spec assert the property that matters — for a non-admin the lookup is not run
  // at all, because the operators' addresses are not part of ruling 3.
  const profiles = {
    emailsOf: vi.fn().mockResolvedValue(new Map([['admin-1', ADMIN.email]])),
  } as unknown as UserProfileService;
  const admin = {
    list: vi.fn().mockResolvedValue([view()]),
    find: vi.fn().mockResolvedValue(view()),
    eventsFor: vi.fn().mockResolvedValue(new Map()),
    listMeasurements: vi.fn().mockResolvedValue([measurement()]),
    measurementUsage: vi.fn().mockResolvedValue(new Map([[MEASUREMENT, 2]])),
    register: vi.fn().mockResolvedValue(view()),
    update: vi.fn().mockResolvedValue(view()),
    setEnabled: vi.fn().mockResolvedValue(view()),
    rotateKey: vi.fn().mockResolvedValue(view()),
    addMeasurement: vi.fn().mockResolvedValue(measurement()),
    updateMeasurementNote: vi.fn().mockResolvedValue(measurement()),
    removeMeasurement: vi.fn().mockResolvedValue(measurement()),
    ...adminOverrides,
  } as unknown as ExternalEndpointAdminService;
  const evidence = {
    summariesFor: vi.fn().mockResolvedValue(new Map()),
    ...evidenceOverrides,
  } as unknown as ExternalEvidenceService;
  return {
    admin,
    evidence,
    profiles,
    resolver: new ExternalEndpointsResolver(
      admin,
      evidence,
      { discover: vi.fn().mockResolvedValue([]) } as unknown as ExternalModelDiscoveryService,
      profiles,
      config(adminEmails),
    ),
  };
}

describe('transparency scoping (ruling 3 on SUP-221)', () => {
  it('answers a signed-in non-admin the endpoint, its status and the verdict it saw', async () => {
    const [endpoint] = await build().resolver.externalEndpoints(MEMBER);

    // The whole point of the ruling: an operator must not be able to curate
    // external capacity in secret.
    expect(endpoint).toMatchObject({
      name: 'partner-cloud',
      baseUrl: 'https://partner.example',
      status: 'verified',
      measurementSeen: MEASUREMENT,
      measurementSource: 'operator-pinned',
      evidenceDigestSeen: DIGEST_NOW,
      pinnedCertFingerprint: LEAF,
    });
    expect(endpoint.models.map((model) => model.id)).toEqual(['partner/llama:snp']);
  });

  it('withholds the operator’s own fields from a non-admin, and does not even look them up', async () => {
    const { profiles, resolver } = build();

    const [endpoint] = await resolver.externalEndpoints(MEMBER);

    expect(endpoint.apiKeyPrefix).toBeNull();
    // What another operator's deployment calls the model is theirs, not this
    // catalogue's — narrowed for the same reason the key prefix is.
    expect(endpoint.models[0].upstreamModel).toBeNull();
    // Not merely omitted from the response: the operators' addresses are not
    // read, so there is no path by which one could leak.
    expect(profiles.emailsOf).not.toHaveBeenCalled();
  });

  it('answers an operator those same two fields', async () => {
    const [endpoint] = await build().resolver.externalEndpoints(ADMIN);

    expect(endpoint.apiKeyPrefix).toBe('sk-upstr');
    expect(endpoint.models[0].upstreamModel).toBe('llama-3.3-70b-instruct');
  });

  it('withholds who added a trust-list entry from a non-admin, and names them to an operator', async () => {
    expect((await build().resolver.trustedMeasurements(MEMBER))[0]).toMatchObject({
      measurement: MEASUREMENT,
      note: 'Partner cloud',
      addedByEmail: null,
      // The count is not an operator field: it is how a reader sees that
      // withdrawing this row would drop two upstreams.
      admits: 2,
    });
    expect((await build().resolver.trustedMeasurements(ADMIN))[0].addedByEmail).toBe('ops@example.test');
  });

  it('treats an address the deployment did not name as a non-admin, however it is spelled', async () => {
    const { resolver } = build({ adminEmails: 'someone-else@example.test' });

    expect((await resolver.externalEndpoints(ADMIN))[0].apiKeyPrefix).toBeNull();
  });
});

describe('the upstream key', () => {
  it('is in no response path, not even the operator’s', async () => {
    const { resolver } = build();

    const responses = [
      await resolver.externalEndpoints(ADMIN),
      await resolver.externalEndpoint(ADMIN, 'ep-1'),
      await resolver.registerExternalEndpoint(ADMIN, {
        name: 'partner-cloud',
        baseUrl: 'https://partner.example',
        apiKey: UPSTREAM_KEY,
        models: [],
      }),
      await resolver.rotateExternalEndpointKey(ADMIN, 'ep-1', { apiKey: UPSTREAM_KEY }),
    ];

    const serialised = JSON.stringify(responses);
    expect(serialised).not.toContain(UPSTREAM_KEY);
    // Nor the envelope: a ciphertext in a response is a ciphertext in a browser's
    // network log, and the only thing a client can do with one is store it.
    expect(serialised).not.toContain('apiKeyCiphertext');
    expect(serialised).toContain('sk-upstr');
  });
});

describe('the catalogue an endpoint reports', () => {
  it('lists what the operator currently offers and not what was retired', async () => {
    const { resolver } = build({
      admin: {
        list: vi.fn().mockResolvedValue([view({}, [model(), model({ id: 'partner/dropped:snp', enabled: false })])]),
      } as Partial<ExternalEndpointAdminService>,
    });

    const [endpoint] = await resolver.externalEndpoints(ADMIN);

    // A retired row stays in `models` so past generations keep their foreign key,
    // but the contract's type has no `enabled`, so a reader shown one could not
    // tell it from a model on offer.
    expect(endpoint.models.map((model) => model.id)).toEqual(['partner/llama:snp']);
  });

  it('reports the prices as the nested money shape every other model uses', async () => {
    const [endpoint] = await build().resolver.externalEndpoints(ADMIN);

    expect(endpoint.models[0].pricing).toEqual({ promptPer1m: '400000', completionPer1m: '800000' });
  });

  it('reports an anchor the enum does not know as “not stated” rather than failing the field', async () => {
    const { resolver } = build({
      admin: {
        list: vi.fn().mockResolvedValue([view({ measurementSource: 'some-future-anchor' })]),
      } as Partial<ExternalEndpointAdminService>,
    });

    // The string comes from the sidecar's report across a seam this repository
    // versions separately; a gatekeeper that grows a third anchor should make the
    // console say nothing, not make the admin screen fail to load.
    expect((await resolver.externalEndpoints(ADMIN))[0].measurementSource).toBeNull();
  });

  it('passes the registry signal of a denial through, without changing the status', async () => {
    const { resolver } = build({
      admin: {
        list: vi
          .fn()
          .mockResolvedValue([
            view({ status: 'denied', lastStage: 'policy', measurementSource: null, measurementInRegistry: true }),
          ]),
      } as Partial<ExternalEndpointAdminService>,
    });

    // SUP-251: informational only — the console badges it, the trust list still decides.
    expect((await resolver.externalEndpoints(MEMBER))[0]).toMatchObject({
      status: 'denied',
      measurementSeen: MEASUREMENT,
      measurementInRegistry: true,
    });
  });
});

describe('the evidence summary (SUP-221 ruling 1)', () => {
  it('gives each timeline entry the publication that entry’s verdict saw', async () => {
    const changed = event({ id: 'evt-2', kind: 'digest_changed', evidenceDigest: DIGEST_BEFORE });
    const { resolver } = build({
      admin: {
        list: vi.fn().mockResolvedValue([view()]),
        eventsFor: vi.fn().mockResolvedValue(new Map([['ep-1', [event(), changed]]])),
      } as Partial<ExternalEndpointAdminService>,
      evidence: {
        summariesFor: vi.fn().mockResolvedValue(
          new Map([
            [
              'ep-1',
              new Map([
                [DIGEST_NOW, snapshot('snap-now', DIGEST_NOW)],
                [DIGEST_BEFORE, snapshot('snap-before', DIGEST_BEFORE)],
              ]),
            ],
          ]),
        ),
      },
    });

    const [endpoint] = await resolver.externalEndpoints(ADMIN);

    // Not "the latest snapshot" on every row: showing today's images beside last
    // week's DIGEST_CHANGED would make the one event cloud-granularity trust
    // exists to surface unreadable.
    expect(endpoint.latestEvidence?.snapshotId).toBe('snap-now');
    expect(endpoint.events.map((entry) => entry.evidence?.snapshotId)).toEqual(['snap-now', 'snap-before']);
    expect(endpoint.events[1].evidence?.containerImages).toEqual(['ghcr.io/example/vllm@sha256:snap-before']);
  });

  it('asks only for the digests the page will render', async () => {
    const { evidence, resolver } = build({
      admin: {
        list: vi.fn().mockResolvedValue([view()]),
        eventsFor: vi
          .fn()
          .mockResolvedValue(
            new Map([
              ['ep-1', [event({ evidenceDigest: DIGEST_BEFORE }), event({ id: 'evt-0', evidenceDigest: null })]],
            ]),
          ),
      } as Partial<ExternalEndpointAdminService>,
    });

    await resolver.externalEndpoints(ADMIN);

    expect(evidence.summariesFor).toHaveBeenCalledWith([
      { externalEndpointId: 'ep-1', evidenceDigest: DIGEST_NOW },
      { externalEndpointId: 'ep-1', evidenceDigest: DIGEST_BEFORE },
    ]);
  });

  it('renders the workloads and both spellings of the fingerprint', async () => {
    const { resolver } = build({
      evidence: {
        summariesFor: vi
          .fn()
          .mockResolvedValue(new Map([['ep-1', new Map([[DIGEST_NOW, snapshot('snap-now', DIGEST_NOW)]])]])),
      },
    });

    const [endpoint] = await resolver.externalEndpoints(ADMIN);

    expect(endpoint.latestEvidence).toMatchObject({
      workloads: [{ kind: 'Deployment', name: 'vllm', namespace: 'partner', containers: ['vllm'] }],
      measurements: [{ name: 'MRTD', value: 'abc123' }],
      certFingerprint: LEAF,
    });
    // Derived rather than stored, the same way `EvidenceSnapshot` derives it.
    expect(endpoint.latestEvidence?.certFingerprintHex).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is null for an endpoint with no verdict, because there is no pin to bind one to', async () => {
    const { resolver } = build({
      admin: {
        list: vi
          .fn()
          .mockResolvedValue([view({ status: 'pending', evidenceDigestSeen: null, pinnedCertFingerprint: null }, [])]),
      } as Partial<ExternalEndpointAdminService>,
    });

    expect((await resolver.externalEndpoints(ADMIN))[0].latestEvidence).toBeNull();
  });
});

describe('mutations', () => {
  it('hands the service the prices as numbers and the key as given', async () => {
    const { admin, resolver } = build();

    await resolver.registerExternalEndpoint(ADMIN, {
      name: 'partner-cloud',
      baseUrl: 'https://partner.example',
      apiKey: UPSTREAM_KEY,
      models: [
        {
          id: 'partner/llama:snp',
          name: 'Llama',
          upstreamModel: 'llama-3.3-70b-instruct',
          contextLength: 131_072,
          capabilities: ['chat'],
          promptPer1mMicros: '400000',
          completionPer1mMicros: '800000',
        },
      ],
    });

    expect(admin.register).toHaveBeenCalledWith({
      name: 'partner-cloud',
      baseUrl: 'https://partner.example',
      apiKey: UPSTREAM_KEY,
      createdByUserId: 'admin-1',
      models: [
        {
          id: 'partner/llama:snp',
          name: 'Llama',
          upstreamModel: 'llama-3.3-70b-instruct',
          contextLength: 131_072,
          capabilities: ['chat'],
          promptPer1mMicros: 400_000,
          completionPer1mMicros: 800_000,
        },
      ],
    });
  });

  it('defaults a model’s capabilities to chat, which is what an OpenAI-compatible upstream serves', async () => {
    const { admin, resolver } = build();

    await resolver.registerExternalEndpoint(ADMIN, {
      name: 'partner-cloud',
      baseUrl: 'https://partner.example',
      apiKey: UPSTREAM_KEY,
      models: [
        {
          id: 'partner/llama:snp',
          name: 'Llama',
          upstreamModel: 'llama-3.3-70b-instruct',
          contextLength: 131_072,
          promptPer1mMicros: '400000',
          completionPer1mMicros: '800000',
        },
      ],
    });

    const [spec] = (admin.register as unknown as { mock: { calls: [{ models: { capabilities: string[] }[] }][] } }).mock
      .calls;
    expect(spec[0].models[0].capabilities).toEqual(['chat']);
  });

  it('takes the endpoint id as an argument rather than inside the payload', async () => {
    const { admin, resolver } = build();

    await resolver.updateExternalEndpoint(ADMIN, 'ep-1', { baseUrl: 'https://elsewhere.example' });
    await resolver.setExternalEndpointEnabled(ADMIN, 'ep-1', { enabled: false });
    await resolver.rotateExternalEndpointKey(ADMIN, 'ep-1', { apiKey: 'sk-rotated' });

    // Which endpoint is being changed is not one of the things being changed.
    expect(admin.update).toHaveBeenCalledWith({ id: 'ep-1', baseUrl: 'https://elsewhere.example', models: undefined });
    expect(admin.setEnabled).toHaveBeenCalledWith('ep-1', false);
    expect(admin.rotateKey).toHaveBeenCalledWith('ep-1', 'sk-rotated');
  });

  it('answers a withdrawal with true rather than the row it deleted', async () => {
    const { resolver } = build();

    // A payload describing the row would describe something that no longer
    // exists, and a console writing it back would re-add what it just removed.
    expect(await resolver.removeTrustedMeasurement(ADMIN, 'tm-1')).toBe(true);
  });

  it('names the operator in a WARN on every mutation', async () => {
    const { resolver } = build();
    const warn = vi.spyOn((resolver as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn');

    await resolver.setExternalEndpointEnabled(ADMIN, 'ep-1', { enabled: false });
    await resolver.addTrustedMeasurement(ADMIN, { measurement: MEASUREMENT });
    await resolver.removeTrustedMeasurement(ADMIN, 'tm-1');

    expect(warn).toHaveBeenCalledTimes(3);
    for (const [line] of warn.mock.calls) {
      // The container log is the only audit trail a published cluster has.
      expect(line).toContain(ADMIN.email);
    }
  });

  it('passes the adding operator through, so the trust list records who admitted a cloud', async () => {
    const { admin, resolver } = build();

    await resolver.addTrustedMeasurement(ADMIN, { measurement: `0x${MEASUREMENT}`, note: 'Partner' });

    expect(admin.addMeasurement).toHaveBeenCalledWith(`0x${MEASUREMENT}`, 'Partner', 'admin-1');
  });
});

describe('the verdict timeline', () => {
  it('is a field of the endpoint, capped by the server rather than by the client', async () => {
    const { admin, resolver } = build();

    await resolver.externalEndpoints(MEMBER);

    // One bulk read for the page, with the cap the server chose: the drawer
    // renders recent history and the container log is the audit trail.
    expect(admin.eventsFor).toHaveBeenCalledWith(['ep-1'], 50);
  });
});

describe('externalEndpoint(id)', () => {
  it('is null rather than an error for an id that is not registered', async () => {
    const { resolver } = build({ admin: { find: vi.fn().mockResolvedValue(null) } });

    expect(await resolver.externalEndpoint(MEMBER, 'missing')).toBeNull();
  });
});
