import { BadRequestException, ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDataSource } from '../../../test/seed.js';
import type { routerConfig } from '../config.js';
import { RouterConfigSchema } from '../config.schema.js';
import { ExternalEndpoint } from '../db/entities/external-endpoint.entity.js';
import { ExternalEndpointEvent } from '../db/entities/external-endpoint-event.entity.js';
import { Model } from '../db/entities/model.entity.js';
import { TrustedMeasurement } from '../db/entities/trusted-measurement.entity.js';
import { SECRETS_KEY_ENV, SecretEnvelopeService } from '../secrets/index.js';
import { ExternalCatalogService } from './external-catalog.service.js';
import {
  canonicalBaseUrl,
  ExternalEndpointAdminService,
  type ExternalModelSpec,
} from './external-endpoint-admin.service.js';
import { ExternalEndpointStatusService } from './external-endpoint-status.service.js';
import type { SidecarConfigWriterService } from './sidecar-config-writer.service.js';

const MEASUREMENT = 'a'.repeat(64);
const KEY = Buffer.alloc(32, 7).toString('base64url');
const UPSTREAM_KEY = 'sk-upstream-super-secret-value';

let dataSource: DataSource;
let service: ExternalEndpointAdminService;
let render: ReturnType<typeof vi.fn>;
let catalog: ExternalCatalogService;

function config(): ConfigType<typeof routerConfig> {
  return RouterConfigSchema.parse({
    auth: { secret: 'a'.repeat(32) },
    externalEndpoints: { listenPortBase: 19_000, listenPortRange: 3 },
  }) as ConfigType<typeof routerConfig>;
}

function model(overrides: Partial<ExternalModelSpec> = {}): ExternalModelSpec {
  return {
    id: 'partner/llama-3.3-70b:snp',
    name: 'Llama 3.3 70B (partner)',
    upstreamModel: 'llama-3.3-70b-instruct',
    contextLength: 131_072,
    capabilities: ['chat'],
    promptPer1mMicros: 400_000,
    completionPer1mMicros: 800_000,
    tee: 'AMD SEV-SNP',
    ...overrides,
  };
}

async function register(overrides: Partial<Parameters<typeof service.register>[0]> = {}) {
  return service.register({
    name: 'partner-cloud',
    baseUrl: 'https://partner.example:8443',
    apiKey: UPSTREAM_KEY,
    models: [model()],
    createdByUserId: 'user-1',
    ...overrides,
  });
}

beforeEach(async () => {
  process.env[SECRETS_KEY_ENV] = KEY;
  dataSource = await createTestDataSource();
  catalog = new ExternalCatalogService(dataSource);
  render = vi.fn().mockResolvedValue({ changed: true, endpoints: 1, trustedMeasurements: 0 });
  service = new ExternalEndpointAdminService(
    config(),
    dataSource,
    new SecretEnvelopeService(),
    { render } as unknown as SidecarConfigWriterService,
    catalog,
    new ExternalEndpointStatusService(config(), dataSource, catalog),
  );
});

afterEach(async () => {
  delete process.env[SECRETS_KEY_ENV];
  await dataSource?.destroy();
});

describe('registering an external endpoint', () => {
  it('starts pending, with a listener of its own and a registered event', async () => {
    const { endpoint, models } = await register();

    // Pending, not verified: no verdict has been read back, so it serves nothing
    // (ADR-008 §8). The row is the sidecar's input, never its conclusion.
    expect(endpoint.status).toBe('pending');
    expect(endpoint.enabled).toBe(true);
    expect(endpoint.listenPort).toBe(19_000);
    expect(endpoint.hostname).toBe('partner.example');
    expect(models.map((row) => [row.id, row.origin, row.externalEndpointId, row.endpointId])).toEqual([
      ['partner/llama-3.3-70b:snp', 'external', endpoint.id, null],
    ]);

    const events = await dataSource.getRepository(ExternalEndpointEvent).find();
    expect(events.map((event) => event.kind)).toEqual(['registered']);
  });

  it('seals the upstream key and keeps nothing but its prefix in reach', async () => {
    const { endpoint } = await register();

    expect(endpoint.apiKeyPrefix).toBe('sk-upstr');
    expect(endpoint.apiKeyCiphertext).toMatch(/^v1\./);
    expect(endpoint.apiKeyCiphertext).not.toContain(UPSTREAM_KEY);
    // The envelope is bound to the row, so the ciphertext cannot be moved to
    // another endpoint and hand that upstream this credential.
    expect(new SecretEnvelopeService().open(endpoint.apiKeyCiphertext, endpoint.id)).toBe(UPSTREAM_KEY);
    expect(() => new SecretEnvelopeService().open(endpoint.apiKeyCiphertext, 'another-row')).toThrow();
  });

  it('renders the sidecar config in the same call, so the edit is live', async () => {
    await register();

    expect(render).toHaveBeenCalledTimes(1);
  });

  it('allocates the lowest free loopback port, and refuses once the window is full', async () => {
    await register();
    await register({ name: 'second', models: [model({ id: 'partner/second:snp' })] });
    await register({ name: 'third', models: [model({ id: 'partner/third:snp' })] });

    const ports = (await dataSource.getRepository(ExternalEndpoint).find({ order: { listenPort: 'ASC' } })).map(
      (row) => row.listenPort,
    );
    expect(ports).toEqual([19_000, 19_001, 19_002]);
    await expect(register({ name: 'fourth', models: [] })).rejects.toThrow(/listenPortRange/);
  });

  it('refuses a name the sidecar could not use as its key', async () => {
    for (const name of ['Partner Cloud', '-leading', 'a'.repeat(64), 'under_score']) {
      await expect(register({ name })).rejects.toThrow(BadRequestException);
    }
  });

  it('refuses a plain-HTTP upstream: there is no channel to bind a verdict to', async () => {
    await expect(register({ baseUrl: 'http://partner.example' })).rejects.toThrow(/not an https URL/);
    await expect(register({ baseUrl: 'partner.example' })).rejects.toThrow(/is not a URL/);
  });

  it('refuses a second endpoint with the same name', async () => {
    await register();
    await expect(register({ models: [model({ id: 'partner/other:snp' })] })).rejects.toThrow(ConflictException);
  });

  it('refuses a model id the catalogue already holds', async () => {
    await dataSource.getRepository(Model).save({
      id: 'meta/llama-3.3-70b-instruct:tdx',
      name: 'Llama',
      litellmModel: 'llama',
      origin: 'config',
      endpointId: null,
      externalEndpointId: null,
      contextLength: 1,
      capabilities: ['chat'],
      promptPer1mMicros: 1,
      completionPer1mMicros: 1,
      tee: 'Intel TDX',
      enabled: true,
      updatedAt: new Date(),
    });

    // The two origins share one table and one primary key, so taking a config
    // model's id would silently re-point a built-in at someone else's upstream.
    await expect(register({ models: [model({ id: 'meta/llama-3.3-70b-instruct:tdx' })] })).rejects.toThrow(
      ConflictException,
    );
  });

  it('refuses the same model id twice in one registration', async () => {
    await expect(register({ models: [model(), model()] })).rejects.toThrow(/listed twice/);
  });

  it('refuses a blank key rather than storing an envelope that proxies nothing', async () => {
    await expect(register({ apiKey: '   ' })).rejects.toThrow(BadRequestException);
  });

  it('refuses outright when the deployment has no data key, and says what to set', async () => {
    delete process.env[SECRETS_KEY_ENV];

    await expect(register()).rejects.toThrow(ServiceUnavailableException);
    await expect(register()).rejects.toThrow(new RegExp(SECRETS_KEY_ENV));
    expect(await dataSource.getRepository(ExternalEndpoint).count()).toBe(0);
  });
});

describe('updating an external endpoint', () => {
  it('renames, re-points and re-derives the hostname', async () => {
    const { endpoint } = await register();

    const updated = await service.update({ id: endpoint.id, name: 'renamed', baseUrl: 'https://other.example/v1' });

    expect(updated.endpoint.name).toBe('renamed');
    // The path is dropped: the sidecar binds an authority, and `/v1` would be
    // rendered away anyway.
    expect(updated.endpoint.baseUrl).toBe('https://other.example');
    expect(updated.endpoint.hostname).toBe('other.example');
  });

  it('re-pointing resets the verdict, so no row vouches for the host it no longer names', async () => {
    const { endpoint } = await register();
    await verify(endpoint.id);
    expect(catalog.find('partner/llama-3.3-70b:snp')).toBeDefined();

    const updated = await service.update({ id: endpoint.id, baseUrl: 'https://elsewhere.example' });

    expect(updated.endpoint.status).toBe('pending');
    expect(updated.endpoint.measurementSeen).toBeNull();
    expect(updated.endpoint.pinnedCertFingerprint).toBeNull();
    // And the model goes with it: admission reads the status column, so leaving it
    // `verified` would route traffic to a host nothing has attested.
    expect(catalog.find('partner/llama-3.3-70b:snp')).toBeUndefined();
  });

  it('renaming keeps the verdict: a name does not move where traffic goes', async () => {
    const { endpoint } = await register();
    await verify(endpoint.id);

    const updated = await service.update({ id: endpoint.id, name: 'renamed' });

    expect(updated.endpoint.status).toBe('verified');
    expect(updated.endpoint.measurementSeen).toBe(MEASUREMENT);
  });

  it('retires a model it no longer lists rather than deleting it', async () => {
    const { endpoint } = await register({ models: [model(), model({ id: 'partner/dropped:snp' })] });

    const updated = await service.update({ id: endpoint.id, models: [model()] });

    // Generations keep their foreign key — the same trade the config projection
    // makes when the config stops listing a model.
    expect(updated.models.map((row) => [row.id, row.enabled])).toEqual([
      ['partner/dropped:snp', false],
      ['partner/llama-3.3-70b:snp', true],
    ]);
  });

  it('lets an endpoint keep its own model ids while refusing another endpoint’s', async () => {
    const first = await register();
    const second = await register({ name: 'second', models: [model({ id: 'partner/second:snp' })] });

    await expect(service.update({ id: first.endpoint.id, models: [model()] })).resolves.toBeDefined();
    await expect(service.update({ id: second.endpoint.id, models: [model()] })).rejects.toThrow(ConflictException);
  });

  it('refuses a name another endpoint already holds', async () => {
    await register();
    const second = await register({ name: 'second', models: [model({ id: 'partner/second:snp' })] });

    await expect(service.update({ id: second.endpoint.id, name: 'partner-cloud' })).rejects.toThrow(ConflictException);
  });

  it('is a 404 for an endpoint that is not there', async () => {
    await expect(service.update({ id: 'missing', name: 'whatever' })).rejects.toThrow(NotFoundException);
  });
});

describe('enabling and disabling', () => {
  it('disabling records the event and takes the endpoint out of the routable set', async () => {
    const { endpoint } = await register();
    await verify(endpoint.id);

    const disabled = await service.setEnabled(endpoint.id, false);

    expect(disabled.endpoint.status).toBe('disabled');
    expect(catalog.find('partner/llama-3.3-70b:snp')).toBeUndefined();
    const events = await dataSource.getRepository(ExternalEndpointEvent).find();
    expect(events.map((event) => event.kind)).toEqual(['registered', 'disabled']);
  });

  it('enabling returns it to pending, so it re-attests before it serves', async () => {
    const { endpoint } = await register();
    await verify(endpoint.id);
    await service.setEnabled(endpoint.id, false);

    const enabled = await service.setEnabled(endpoint.id, true);

    // The verdict it held before it was switched off is not a statement about the
    // upstream now — the same reason a restart resets every row (§8).
    expect(enabled.endpoint.status).toBe('pending');
    expect(enabled.endpoint.measurementSeen).toBeNull();
    expect(enabled.endpoint.pinnedCertFingerprint).toBeNull();
  });

  it('is a no-op when the switch is already where it is asked to be', async () => {
    const { endpoint } = await register();
    render.mockClear();

    await service.setEnabled(endpoint.id, true);

    expect(render).not.toHaveBeenCalled();
    expect(await dataSource.getRepository(ExternalEndpointEvent).count()).toBe(1);
  });
});

describe('rotating the upstream key', () => {
  it('replaces the envelope and the prefix, and records it', async () => {
    const { endpoint } = await register();

    const rotated = await service.rotateKey(endpoint.id, 'sk-rotated-value');

    expect(rotated.endpoint.apiKeyPrefix).toBe('sk-rotat');
    expect(new SecretEnvelopeService().open(rotated.endpoint.apiKeyCiphertext, endpoint.id)).toBe('sk-rotated-value');
    const events = await dataSource.getRepository(ExternalEndpointEvent).find();
    expect(events.map((event) => event.kind)).toEqual(['registered', 'key_rotated']);
  });

  it('does not re-render: the rendered config holds no secrets', async () => {
    const { endpoint } = await register();
    render.mockClear();

    await service.rotateKey(endpoint.id, 'sk-rotated-value');

    expect(render).not.toHaveBeenCalled();
  });

  it('refuses a blank replacement', async () => {
    const { endpoint } = await register();

    await expect(service.rotateKey(endpoint.id, '')).rejects.toThrow(BadRequestException);
  });
});

describe('the trust list', () => {
  it('normalises on the way in, so one cloud is one row', async () => {
    const added = await service.addMeasurement(`0x${MEASUREMENT.toUpperCase()}`, '  Partner cloud  ', 'user-1');

    expect(added.measurement).toBe(MEASUREMENT);
    expect(added.note).toBe('Partner cloud');
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('refuses a repeat however it was spelled', async () => {
    await service.addMeasurement(MEASUREMENT, null, 'user-1');

    await expect(service.addMeasurement(`sha256:${MEASUREMENT}`, null, 'user-1')).rejects.toThrow(ConflictException);
    expect(await dataSource.getRepository(TrustedMeasurement).count()).toBe(1);
  });

  it('refuses something that is not a measurement', async () => {
    await expect(service.addMeasurement('not-a-measurement', null, null)).rejects.toThrow(BadRequestException);
  });

  it('rewrites the note, and a blank note clears it', async () => {
    const added = await service.addMeasurement(MEASUREMENT, 'first', 'user-1');

    expect((await service.updateMeasurementNote(added.id, 'second')).note).toBe('second');
    expect((await service.updateMeasurementNote(added.id, '   ')).note).toBeNull();
  });

  it('withdrawing re-renders, because the removal is the kill switch', async () => {
    const added = await service.addMeasurement(MEASUREMENT, null, 'user-1');
    render.mockClear();

    const removed = await service.removeMeasurement(added.id);

    expect(removed.measurement).toBe(MEASUREMENT);
    expect(await dataSource.getRepository(TrustedMeasurement).count()).toBe(0);
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('is a 404 for an entry that is not there', async () => {
    await expect(service.removeMeasurement('missing')).rejects.toThrow(NotFoundException);
    await expect(service.updateMeasurementNote('missing', 'x')).rejects.toThrow(NotFoundException);
  });
});

describe('reads', () => {
  it('lists endpoints by name with their own models', async () => {
    await register({ name: 'zulu', models: [model({ id: 'partner/zulu:snp' })] });
    await register({ name: 'alpha', models: [model({ id: 'partner/alpha:snp' })] });

    const views = await service.list();

    expect(views.map((view) => view.endpoint.name)).toEqual(['alpha', 'zulu']);
    expect(views.map((view) => view.models.map((row) => row.id))).toEqual([
      ['partner/alpha:snp'],
      ['partner/zulu:snp'],
    ]);
  });

  it('returns the timeline newest first, bounded by the limit', async () => {
    const { endpoint } = await register();
    await service.rotateKey(endpoint.id, 'sk-two');
    await service.setEnabled(endpoint.id, false);

    const events = await service.events(endpoint.id, 2);

    expect(events).toHaveLength(2);
    expect(events[0].kind).toBe('disabled');
  });

  it('refuses a timeline for an endpoint that is not there', async () => {
    await expect(service.events('missing', 10)).rejects.toThrow(NotFoundException);
  });
});

describe('canonicalBaseUrl', () => {
  it('keeps scheme and authority and drops everything else', () => {
    expect(canonicalBaseUrl('https://host:8443/v1/?x=1#f')).toBe('https://host:8443');
    expect(canonicalBaseUrl('  https://host/v1  ')).toBe('https://host');
  });
});

/** Puts a live `verified` verdict on a row, the way the status poll would. */
async function verify(id: string): Promise<void> {
  await dataSource.getRepository(ExternalEndpoint).update(
    { id },
    {
      status: 'verified',
      measurementSeen: MEASUREMENT,
      pinnedCertFingerprint: 'sha256/leaf',
      lastCheckedAt: new Date(),
    },
  );
  await catalog.refresh();
}
