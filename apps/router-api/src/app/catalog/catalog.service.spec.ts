import type { ConfigType } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { routerConfig } from '../config.js';
import { buildDataSourceOptions } from '../db/data-source.js';
import { Endpoint } from '../db/entities/endpoint.entity.js';
import { Model } from '../db/entities/model.entity.js';
import { CatalogService, UnknownEndpointError } from './catalog.service.js';

/**
 * The projection is the reason a `Generation` can take a foreign key on the
 * model it used, so what it does with a *changed* config — and with a broken
 * one — is the part worth pinning down (`data-model.md` invariant 4).
 */

let dataSource: DataSource;

const ENDPOINT = { name: 'primary', hostname: 'primary.tee.example', tee: 'Intel TDX', enabled: true };
const MODEL = {
  id: 'vendor/model:tdx',
  name: 'Model',
  litellmModel: 'vllm/model',
  endpoint: 'primary',
  contextLength: 4096,
  capabilities: ['chat'] as const,
  pricing: { promptPer1mMicros: 100, completionPer1mMicros: 200 },
  enabled: true,
};

beforeEach(async () => {
  dataSource = new DataSource(
    buildDataSourceOptions({ type: 'sqlite', file: ':memory:', migrationsRun: false, logging: false }),
  );
  await dataSource.initialize();
  await dataSource.runMigrations();
});

afterEach(async () => {
  await dataSource.destroy();
});

/** Builds a catalogue over the given endpoints and models, already projected. */
async function catalogue(
  endpoints: Record<string, unknown>[],
  models: Record<string, unknown>[],
): Promise<CatalogService> {
  const config = { endpoints, models } as unknown as ConfigType<typeof routerConfig>;
  const service = new CatalogService(config, dataSource);
  await service.onApplicationBootstrap();
  return service;
}

describe('projection', () => {
  it('writes the config into the endpoints and models tables', async () => {
    await catalogue([ENDPOINT], [MODEL]);

    const endpoint = await dataSource.getRepository(Endpoint).findOneByOrFail({ name: 'primary' });
    expect(endpoint).toMatchObject({ hostname: 'primary.tee.example', tee: 'Intel TDX', enabled: true });

    const model = await dataSource.getRepository(Model).findOneByOrFail({ id: 'vendor/model:tdx' });
    expect(model).toMatchObject({
      litellmModel: 'vllm/model',
      endpointId: endpoint.id,
      promptPer1mMicros: 100,
      completionPer1mMicros: 200,
      // Denormalised from the endpoint, so a model list needs no join.
      tee: 'Intel TDX',
      enabled: true,
    });
  });

  it('keeps an endpoint s id across restarts, so old generations still resolve', async () => {
    await catalogue([ENDPOINT], [MODEL]);
    const first = await dataSource.getRepository(Endpoint).findOneByOrFail({ name: 'primary' });

    await catalogue([{ ...ENDPOINT, hostname: 'moved.tee.example' }], [MODEL]);
    const second = await dataSource.getRepository(Endpoint).findOneByOrFail({ name: 'primary' });

    expect(second.id).toBe(first.id);
    expect(second.hostname).toBe('moved.tee.example');
  });

  it('retires what the config dropped instead of deleting it', async () => {
    await catalogue([ENDPOINT], [MODEL, { ...MODEL, id: 'vendor/retired:tdx' }]);

    await catalogue([ENDPOINT], [MODEL]);

    const retired = await dataSource.getRepository(Model).findOneByOrFail({ id: 'vendor/retired:tdx' });
    expect(retired.enabled).toBe(false);
    expect(await dataSource.getRepository(Model).count()).toBe(2);
  });

  it('retires everything when the config lists nothing, which is the development default', async () => {
    await catalogue([ENDPOINT], [MODEL]);

    const empty = await catalogue([], []);

    expect(empty.list()).toEqual([]);
    expect((await dataSource.getRepository(Model).findOneByOrFail({ id: MODEL.id })).enabled).toBe(false);
    expect((await dataSource.getRepository(Endpoint).findOneByOrFail({ name: 'primary' })).enabled).toBe(false);
  });

  it('refuses to boot on a model that names an endpoint nobody declared', async () => {
    await expect(catalogue([ENDPOINT], [{ ...MODEL, endpoint: 'ghost' }])).rejects.toBeInstanceOf(UnknownEndpointError);
  });

  it('ignores entries the config disabled', async () => {
    const service = await catalogue([ENDPOINT], [{ ...MODEL, enabled: false }]);

    expect(service.list()).toEqual([]);
  });
});

describe('lookup', () => {
  it('resolves a model with its endpoint attached', async () => {
    const service = await catalogue([ENDPOINT], [MODEL]);

    expect(service.find('vendor/model:tdx')).toMatchObject({
      litellmModel: 'vllm/model',
      endpoint: { name: 'primary', hostname: 'primary.tee.example' },
    });
    expect(service.find('vendor/absent:tdx')).toBeUndefined();
  });

  it('narrows the list to a key s scope', async () => {
    const service = await catalogue([ENDPOINT], [MODEL, { ...MODEL, id: 'vendor/other:tdx' }]);

    expect(service.list(['vendor/other:tdx']).map((model) => model.id)).toEqual(['vendor/other:tdx']);
    expect(service.list(null)).toHaveLength(2);
    expect(service.list([])).toEqual([]);
  });

  it('resolves an endpoint by the id a generation stored', async () => {
    const service = await catalogue([ENDPOINT], [MODEL]);
    const endpointId = service.find('vendor/model:tdx')?.endpoint.id as string;

    expect(service.endpointById(endpointId)?.name).toBe('primary');
    expect(service.endpointById('nope')).toBeUndefined();
  });
});
