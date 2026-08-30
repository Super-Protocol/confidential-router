import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConfigType } from '@nestjs/config';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { createSqliteFixture, type SqliteFixture } from '../../../test/sqlite.js';
import type { routerConfig } from '../config.js';
import { type RouterConfig, RouterConfigSchema } from '../config.schema.js';
import { Endpoint } from '../db/entities/endpoint.entity.js';
import { Model } from '../db/entities/model.entity.js';
import { CatalogService } from './catalog.service.js';

const here = dirname(fileURLToPath(import.meta.url));
const SEED_FILE = join(here, '..', '..', '..', 'conf', 'router.dev-seed.yaml');

/** The committed development seed, parsed the way the boot path parses it. */
function seedConfig(overrides: Partial<RouterConfig> = {}): RouterConfig {
  const seed = parseYaml(readFileSync(SEED_FILE, 'utf8')) as Record<string, unknown>;
  return RouterConfigSchema.parse({ ...seed, auth: { secret: 'a'.repeat(32) }, ...overrides });
}

function serviceFor(config: RouterConfig, dataSource: DataSource): CatalogService {
  return new CatalogService(config as ConfigType<typeof routerConfig>, dataSource);
}

let fixture: SqliteFixture;

beforeEach(async () => {
  fixture = await createSqliteFixture('cr-catalog-');
});

afterEach(async () => {
  await fixture?.close();
});

/**
 * The committed development seed, projected.
 *
 * The generic projection rules — id stability, retirement, disabled entries, a
 * model naming an endpoint nobody declared — are pinned in
 * `catalog.service.spec.ts`. What is pinned here is that the file a developer
 * actually boots the console against produces the catalogue the design
 * prototype shows: eight open-weight models across three confidential
 * endpoints, with their prices.
 */
describe('the development seed, projected', () => {
  it('projects the development seed: the prototype’s 8 models across 3 endpoints', async () => {
    await serviceFor(seedConfig(), fixture.dataSource).onApplicationBootstrap();

    const endpoints = await fixture.dataSource.getRepository(Endpoint).find();
    const models = await fixture.dataSource.getRepository(Model).find();

    expect(endpoints.map((endpoint) => endpoint.name).sort()).toEqual(['deepseek-v3', 'llama-33-70b', 'qwen25-72b']);
    expect(models).toHaveLength(8);
    expect(models.every((model) => model.enabled)).toBe(true);
  });

  it('copies a model’s config values, prices included', async () => {
    await serviceFor(seedConfig(), fixture.dataSource).onApplicationBootstrap();

    const model = await fixture.dataSource
      .getRepository(Model)
      .findOneOrFail({ where: { id: 'meta/llama-3.3-70b-instruct:tdx' } });

    expect(model).toMatchObject({
      name: 'Llama 3.3 70B Instruct',
      litellmModel: 'vllm/llama-3.3-70b-instruct',
      contextLength: 131072,
      promptPer1mMicros: 280000,
      completionPer1mMicros: 420000,
      capabilities: ['chat', 'completions'],
    });
  });

  it('denormalises the endpoint’s TEE label onto the model so a listing needs no join', async () => {
    await serviceFor(seedConfig(), fixture.dataSource).onApplicationBootstrap();

    const repository = fixture.dataSource.getRepository(Model);
    const onSnp = await repository.findOneOrFail({ where: { id: 'meta/llama-3.1-8b-instruct:snp' } });
    const endpoint = await fixture.dataSource.getRepository(Endpoint).findOneOrFail({ where: { name: 'qwen25-72b' } });

    expect(onSnp.endpointId).toBe(endpoint.id);
    expect(onSnp.tee).toBe(endpoint.tee);
  });

  it('serves the catalogue from memory in config order', async () => {
    const service = serviceFor(seedConfig(), fixture.dataSource);
    await service.onApplicationBootstrap();

    expect(service.list().map((model) => model.id)).toEqual([
      'meta/llama-3.3-70b-instruct:tdx',
      'alibaba/qwen2.5-72b-instruct:snp',
      'deepseek/deepseek-v3:tdx',
      'mistral/mixtral-8x22b:snp',
      'alibaba/qwen2.5-coder-32b:tdx',
      'google/gemma-2-27b-it:tdx',
      'meta/llama-3.1-8b-instruct:snp',
      'microsoft/phi-4:tdx',
    ]);
    expect(service.find('microsoft/phi-4:tdx')?.endpoint.hostname).toBe('llama-33-70b.tee.swarm.cloud');
  });
});
