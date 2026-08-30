import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ApiKeyService, type CreateApiKeyInput } from '../src/app/api-keys/api-key.service.js';
import { Workspace } from '../src/app/db/entities/workspace.entity.js';

/** Priced at one micro-USD per token, so every assertion about cost is exact. */
const PRICING = { promptPer1mMicros: 1_000_000, completionPer1mMicros: 1_000_000 };

interface ModelFixture {
  id: string;
  litellmModel: string;
  capabilities?: string[];
  endpoint?: string;
}

/**
 * One model per upstream behaviour the mock implements. The public id and the
 * `litellmModel` differ deliberately: every test that inspects what the router
 * forwarded is really checking that the rewrite happened.
 */
const MODELS: ModelFixture[] = [
  { id: 'mock/chat:tdx', litellmModel: 'mock/chat', capabilities: ['chat', 'completions'] },
  { id: 'mock/scoped:tdx', litellmModel: 'mock/chat' },
  { id: 'mock/no-usage:tdx', litellmModel: 'mock/no-usage' },
  { id: 'mock/boom:tdx', litellmModel: 'mock/boom' },
  { id: 'mock/overloaded:tdx', litellmModel: 'mock/overloaded' },
  { id: 'mock/context:tdx', litellmModel: 'mock/context' },
  { id: 'mock/refuses:tdx', litellmModel: 'mock/refuses' },
  { id: 'mock/garbage:tdx', litellmModel: 'mock/garbage' },
  { id: 'mock/hangup:tdx', litellmModel: 'mock/hangup' },
  { id: 'mock/stream-abort:tdx', litellmModel: 'mock/stream-abort' },
  { id: 'mock/stream-slow:tdx', litellmModel: 'mock/stream-slow' },
  { id: 'mock/covered:tdx', litellmModel: 'mock/chat', endpoint: 'mock-covered' },
  { id: 'mock/stale:tdx', litellmModel: 'mock/chat', endpoint: 'mock-stale' },
  { id: 'mock/embed:tdx', litellmModel: 'mock/embed', capabilities: ['embeddings'], endpoint: 'mock-embeddings' },
];

export const PRIMARY_ENDPOINT_HOSTNAME = 'primary.mock.tee.example';
export const EMBEDDINGS_ENDPOINT_HOSTNAME = 'embeddings.mock.tee.example';

/** The `router.yaml` the gateway suites boot against. */
export function routerConfigFor(
  litellmBaseUrl: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: 1,
    backends: {
      litellm: { baseUrl: litellmBaseUrl, apiKey: 'mock-litellm-key', connectTimeout: '2s', readTimeout: '5s' },
    },
    endpoints: [
      { name: 'mock-primary', hostname: PRIMARY_ENDPOINT_HOSTNAME, tee: 'Intel TDX + H100 CC' },
      { name: 'mock-embeddings', hostname: EMBEDDINGS_ENDPOINT_HOSTNAME, tee: 'AMD SEV-SNP' },
      { name: 'mock-covered', hostname: 'covered.mock.tee.example', tee: 'Intel TDX' },
      { name: 'mock-stale', hostname: 'stale.mock.tee.example', tee: 'Intel TDX' },
    ],
    models: MODELS.map((model) => ({
      id: model.id,
      name: model.id,
      litellmModel: model.litellmModel,
      endpoint: model.endpoint ?? 'mock-primary',
      contextLength: 4096,
      capabilities: model.capabilities ?? ['chat'],
      pricing: PRICING,
    })),
    ...overrides,
  };
}

export async function seedWorkspace(app: INestApplication, balanceMicros = 10_000_000): Promise<Workspace> {
  const workspace = app
    .get(DataSource)
    .getRepository(Workspace)
    .create({
      id: randomUUID(),
      name: 'Fixture',
      slug: `fixture-${randomUUID().slice(0, 8)}`,
      balanceMicros,
      autoTopUpEnabled: false,
      createdAt: new Date(),
    });
  return app.get(DataSource).getRepository(Workspace).save(workspace);
}

export async function createKey(
  app: INestApplication,
  workspaceId: string,
  overrides: Partial<CreateApiKeyInput> = {},
): Promise<{ secret: string; id: string }> {
  const created = await app.get(ApiKeyService).create({
    workspaceId,
    createdByUserId: randomUUID(),
    name: 'fixture key',
    ...overrides,
  });
  return { secret: created.secret, id: created.key.id };
}

export function bearer(secret: string): Record<string, string> {
  return { Authorization: `Bearer ${secret}` };
}
