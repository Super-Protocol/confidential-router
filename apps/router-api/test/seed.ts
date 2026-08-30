import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { loadRouterConfig, type RouterConfig } from '../src/app/config.js';
import { buildDataSourceOptions } from '../src/app/db/data-source.js';
import { ApiKey } from '../src/app/db/entities/api-key.entity.js';
import { Endpoint } from '../src/app/db/entities/endpoint.entity.js';
import { EvidenceSnapshot } from '../src/app/db/entities/evidence-snapshot.entity.js';
import { Generation, type GenerationStatus } from '../src/app/db/entities/generation.entity.js';
import { Model } from '../src/app/db/entities/model.entity.js';
import { Workspace } from '../src/app/db/entities/workspace.entity.js';

/**
 * An in-memory database with the real migrations applied — not `synchronize` —
 * so a unit test runs against the same schema production does, foreign keys and
 * column types included.
 */
export async function createTestDataSource(): Promise<DataSource> {
  const dataSource = new DataSource(
    buildDataSourceOptions({ type: 'sqlite', file: ':memory:', migrationsRun: false, logging: false }),
  );
  await dataSource.initialize();
  await dataSource.runMigrations();
  return dataSource;
}

/** A config with schema defaults, plus whatever a test needs to override. */
export function testConfig(overrides: Record<string, string> = {}): RouterConfig {
  return loadRouterConfig({
    env: {
      NODE_ENV: 'test',
      CR_API_CONFIG_FILE: '/nonexistent/router.yaml',
      CR_API_AUTH__SECRET: 'unit-test-secret-'.padEnd(48, 'x'),
      ...overrides,
    },
  });
}

export interface Catalog {
  workspaceId: string;
  endpointId: string;
  modelId: string;
  apiKeyId: string;
  snapshotId: string;
  evidenceDigest: string;
}

/** Endpoint names, hostnames and model ids are unique, so each call gets its own. */
let catalogs = 0;

/** The rows a `Generation` needs to exist before it can reference them. */
export async function seedCatalog(dataSource: DataSource, balanceMicros = 0): Promise<Catalog> {
  const workspaceId = randomUUID();
  const endpointId = randomUUID();
  const apiKeyId = randomUUID();
  const snapshotId = randomUUID();
  catalogs += 1;
  const nth = catalogs;
  const endpointName = `llama-33-70b-${nth}`;
  const modelId = `meta/llama-3.3-70b-instruct-${nth}:tdx`;

  await dataSource.getRepository(Workspace).insert({
    id: workspaceId,
    name: 'Test workspace',
    slug: `ws-${workspaceId.slice(0, 8)}`,
    balanceMicros,
    autoTopUpEnabled: false,
    createdAt: new Date(),
  });
  await dataSource.getRepository(Endpoint).insert({
    id: endpointId,
    name: endpointName,
    hostname: `${endpointName}.tee.example`,
    tee: 'Intel TDX + H100 CC',
    enabled: true,
    updatedAt: new Date(),
  });
  await dataSource.getRepository(Model).insert({
    id: modelId,
    name: 'Llama 3.3 70B Instruct',
    litellmModel: 'llama-3.3-70b',
    endpointId,
    contextLength: 131072,
    capabilities: ['chat'],
    promptPer1mMicros: 280_000,
    completionPer1mMicros: 420_000,
    tee: 'Intel TDX + H100 CC',
    enabled: true,
    updatedAt: new Date(),
  });
  await dataSource.getRepository(ApiKey).insert({
    id: apiKeyId,
    workspaceId,
    name: 'Production',
    keyHash: randomUUID().replace(/-/g, ''),
    prefix: 'sk-tee-v1-4f',
    modelScope: null,
    spentTotalMicros: 0,
    createdAt: new Date(),
  });
  await dataSource.getRepository(EvidenceSnapshot).insert({
    id: snapshotId,
    endpointId,
    fetchedAt: new Date('2026-08-01T00:00:00Z'),
    issuedAt: new Date('2026-08-01T00:00:00Z'),
    evidenceDigest: `sha256/6b1f9c04-${nth}`,
    evidenceDigestHex: `6b1f9c04${nth}`,
    certFingerprint: 'sha256/certfingerprint',
    quoteFormat: 'intel-tdx-quote-v5',
    containerImages: ['ghcr.io/example/router@sha256:abc'],
    chainSummary: [],
    measurements: { MRTD: 'aabb' },
    jws: 'eyJhbGciOiJFUzI1NksifQ.payload.signature',
    bundle: { version: 1, evidenceDigest: `sha256/6b1f9c04-${nth}` },
  });

  return { workspaceId, endpointId, modelId, apiKeyId, snapshotId, evidenceDigest: `sha256/6b1f9c04-${nth}` };
}

export interface GenerationSeed {
  createdAt: Date;
  costMicros?: number;
  promptTokens?: number;
  completionTokens?: number;
  latencyMs?: number;
  timeToFirstTokenMs?: number | null;
  tokensPerSecond?: number | null;
  status?: GenerationStatus;
  covered?: boolean;
  apiKeyId?: string | null;
  modelId?: string;
}

export async function seedGeneration(
  dataSource: DataSource,
  catalog: Catalog,
  seed: GenerationSeed,
): Promise<Generation> {
  const covered = seed.covered ?? true;
  const values = {
    id: `gen-${randomUUID()}`,
    workspaceId: catalog.workspaceId,
    apiKeyId: seed.apiKeyId === undefined ? catalog.apiKeyId : seed.apiKeyId,
    modelId: seed.modelId ?? catalog.modelId,
    endpointId: catalog.endpointId,
    evidenceSnapshotId: covered ? catalog.snapshotId : null,
    evidenceDigest: covered ? catalog.evidenceDigest : null,
    promptTokens: seed.promptTokens ?? 100,
    completionTokens: seed.completionTokens ?? 50,
    costMicros: seed.costMicros ?? 1_000,
    promptPer1mMicros: 280_000,
    completionPer1mMicros: 420_000,
    streamed: false,
    status: seed.status ?? ('ok' as GenerationStatus),
    errorCode: null,
    finishReason: 'stop',
    latencyMs: seed.latencyMs ?? 500,
    timeToFirstTokenMs: seed.timeToFirstTokenMs === undefined ? 120 : seed.timeToFirstTokenMs,
    tokensPerSecond: seed.tokensPerSecond === undefined ? 42 : seed.tokensPerSecond,
    requestId: null,
    clientIpHash: null,
    createdAt: seed.createdAt,
  };
  await dataSource.getRepository(Generation).insert(values);
  return dataSource.getRepository(Generation).create(values);
}
