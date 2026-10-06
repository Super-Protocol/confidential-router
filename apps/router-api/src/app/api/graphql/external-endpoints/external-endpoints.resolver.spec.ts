import type { ConfigType } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { SessionUser, UserProfileService } from '../../../auth/index.js';
import type { routerConfig } from '../../../config.js';
import { RouterConfigSchema } from '../../../config.schema.js';
import { ExternalEndpoint } from '../../../db/entities/external-endpoint.entity.js';
import { Model } from '../../../db/entities/model.entity.js';
import { TrustedMeasurement } from '../../../db/entities/trusted-measurement.entity.js';
import type { ExternalEndpointAdminService, ExternalEndpointView } from '../../../external-endpoints/index.js';
import { ExternalEndpointsResolver } from './external-endpoints.resolver.js';

const ADMIN: SessionUser = { id: 'admin-1', email: 'ops@example.test', name: 'Ops', image: null };
const MEMBER: SessionUser = { id: 'member-1', email: 'user@example.test', name: 'User', image: null };
const MEASUREMENT = 'a'.repeat(64);
const UPSTREAM_KEY = 'sk-upstream-super-secret-value';

function config(adminEmails = 'ops@example.test'): ConfigType<typeof routerConfig> {
  return RouterConfigSchema.parse({
    auth: { secret: 'a'.repeat(32), adminEmails: [adminEmails] },
  }) as ConfigType<typeof routerConfig>;
}

function view(): ExternalEndpointView {
  const now = new Date('2026-10-06T12:00:00.000Z');
  return {
    endpoint: {
      id: 'ep-1',
      name: 'partner-cloud',
      baseUrl: 'https://partner.example',
      hostname: 'partner.example',
      listenPort: 19_000,
      enabled: true,
      status: 'verified',
      lastCheckedAt: now,
      lastStage: null,
      lastReason: null,
      measurementSeen: MEASUREMENT,
      measurementSource: 'operator-pinned',
      evidenceDigestSeen: 'sha256/abc',
      pinnedCertFingerprint: 'sha256/leaf',
      apiKeyCiphertext: `v1.${Buffer.from(UPSTREAM_KEY).toString('base64url')}`,
      apiKeyPrefix: 'sk-upstr',
      createdByUserId: 'admin-1',
      createdAt: now,
      updatedAt: now,
    } as ExternalEndpoint,
    models: [
      {
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
        tee: 'AMD SEV-SNP',
        enabled: true,
        updatedAt: now,
      } as Model,
    ],
  };
}

function measurement(): TrustedMeasurement {
  return {
    id: 'tm-1',
    measurement: MEASUREMENT,
    note: 'Partner cloud',
    addedByUserId: 'admin-1',
    addedAt: new Date('2026-10-06T12:00:00.000Z'),
  };
}

function build(overrides: Partial<ExternalEndpointAdminService> = {}, adminEmails?: string) {
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
    events: vi.fn().mockResolvedValue([]),
    listMeasurements: vi.fn().mockResolvedValue([measurement()]),
    register: vi.fn().mockResolvedValue(view()),
    update: vi.fn().mockResolvedValue(view()),
    setEnabled: vi.fn().mockResolvedValue(view()),
    rotateKey: vi.fn().mockResolvedValue(view()),
    addMeasurement: vi.fn().mockResolvedValue(measurement()),
    updateMeasurementNote: vi.fn().mockResolvedValue(measurement()),
    removeMeasurement: vi.fn().mockResolvedValue(measurement()),
    ...overrides,
  } as unknown as ExternalEndpointAdminService;
  return { admin, profiles, resolver: new ExternalEndpointsResolver(admin, profiles, config(adminEmails)) };
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
      evidenceDigestSeen: 'sha256/abc',
      pinnedCertFingerprint: 'sha256/leaf',
    });
    expect(endpoint.models.map((model) => model.id)).toEqual(['partner/llama:snp']);
  });

  it('withholds the operator’s own fields from a non-admin, and does not even look them up', async () => {
    const { profiles, resolver } = build();

    const [endpoint] = await resolver.externalEndpoints(MEMBER);

    expect(endpoint.apiKeyPrefix).toBeNull();
    expect(endpoint.registeredBy).toBeNull();
    // Not merely omitted from the response: the operators' addresses are not
    // read, so there is no path by which one could leak.
    expect(profiles.emailsOf).not.toHaveBeenCalled();
  });

  it('answers an operator those same two fields', async () => {
    const [endpoint] = await build().resolver.externalEndpoints(ADMIN);

    expect(endpoint.apiKeyPrefix).toBe('sk-upstr');
    expect(endpoint.registeredBy).toBe('ops@example.test');
  });

  it('withholds who added a trust-list entry from a non-admin, and names them to an operator', async () => {
    expect((await build().resolver.trustedMeasurements(MEMBER))[0]).toMatchObject({
      measurement: MEASUREMENT,
      note: 'Partner cloud',
      addedBy: null,
    });
    expect((await build().resolver.trustedMeasurements(ADMIN))[0].addedBy).toBe('ops@example.test');
  });

  it('treats an address the deployment did not name as a non-admin, however it is spelled', async () => {
    const { resolver } = build({}, 'someone-else@example.test');

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
      await resolver.rotateExternalEndpointKey(ADMIN, { id: 'ep-1', apiKey: UPSTREAM_KEY }),
    ];

    const serialised = JSON.stringify(responses);
    expect(serialised).not.toContain(UPSTREAM_KEY);
    // Nor the envelope: a ciphertext in a response is a ciphertext in a browser's
    // network log, and the only thing a client can do with one is store it.
    expect(serialised).not.toContain('apiKeyCiphertext');
    expect(serialised).toContain('sk-upstr');
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
          tee: 'AMD SEV-SNP',
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
          tee: 'AMD SEV-SNP',
        },
      ],
    });
  });

  it('names the operator in a WARN on every mutation', async () => {
    const { resolver } = build();
    const warn = vi.spyOn((resolver as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn');

    await resolver.setExternalEndpointEnabled(ADMIN, { id: 'ep-1', enabled: false });
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
  it('clamps the limit rather than letting a client ask for the whole table', async () => {
    const { admin, resolver } = build();

    await resolver.externalEndpointEvents('ep-1', 10_000);
    await resolver.externalEndpointEvents('ep-1', 0);
    await resolver.externalEndpointEvents('ep-1');

    expect((admin.events as unknown as { mock: { calls: unknown[][] } }).mock.calls).toEqual([
      ['ep-1', 200],
      ['ep-1', 1],
      ['ep-1', 50],
    ]);
  });
});

describe('externalEndpoint(id)', () => {
  it('is null rather than an error for an id that is not registered', async () => {
    const { resolver } = build({ find: vi.fn().mockResolvedValue(null) });

    expect(await resolver.externalEndpoint(MEMBER, 'missing')).toBeNull();
  });
});
