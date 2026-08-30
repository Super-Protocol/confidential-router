import request from 'supertest';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiKeyService } from '../src/app/api-keys/api-key.service.js';
import { ApiKey } from '../src/app/db/entities/api-key.entity.js';
import { Generation } from '../src/app/db/entities/generation.entity.js';
import { createHarness, type Harness } from './app-harness.js';
import {
  bearer,
  createKey,
  EMBEDDINGS_ENDPOINT_HOSTNAME,
  PRIMARY_ENDPOINT_HOSTNAME,
  routerConfigFor,
  seedWorkspace,
} from './gateway-fixture.js';
import { COMPLETION_BODY, MockLiteLlm } from './mock-litellm.js';

const upstream = new MockLiteLlm();

let harness: Harness;
let secret: string;
let keyId: string;
let workspaceId: string;

beforeAll(async () => {
  const baseUrl = await upstream.start();
  harness = await createHarness({ config: routerConfigFor(baseUrl) });
  const workspace = await seedWorkspace(harness.app);
  workspaceId = workspace.id;
  const key = await createKey(harness.app, workspaceId);
  secret = key.secret;
  keyId = key.id;
}, 60_000);

afterAll(async () => {
  await harness?.close();
  await upstream.stop();
});

beforeEach(() => {
  upstream.reset();
});

function server() {
  return harness.app.getHttpServer();
}

function generations() {
  return harness.app.get(DataSource).getRepository(Generation);
}

const CHAT = { model: 'mock/chat:tdx', messages: [{ role: 'user', content: 'Hello there' }] };

describe('authentication', () => {
  it('refuses a request with no credential, in the OpenAI error shape', async () => {
    const response = await request(server()).post('/v1/chat/completions').send(CHAT).expect(401);

    expect(response.body).toEqual({
      error: {
        message: expect.stringContaining('Incorrect API key'),
        type: 'authentication_error',
        code: 'invalid_api_key',
      },
    });
  });

  it.each([
    ['a malformed token', 'not-a-key'],
    ['a well-formed token nobody minted', `sk-tee-v1-${'a'.repeat(43)}`],
  ])('refuses %s', async (_case, token) => {
    const response = await request(server()).post('/v1/chat/completions').set(bearer(token)).send(CHAT).expect(401);

    expect(response.body.error.code).toBe('invalid_api_key');
  });

  it('does not accept a console session cookie', async () => {
    const response = await request(server())
      .post('/v1/chat/completions')
      .set('Cookie', 'better-auth.session_token=whatever')
      .send(CHAT)
      .expect(401);

    expect(response.body.error.code).toBe('invalid_api_key');
  });

  it('refuses a revoked key with its own code', async () => {
    const revoked = await createKey(harness.app, workspaceId);
    const repository = harness.app.get(DataSource).getRepository(ApiKey);
    await repository.update({ id: revoked.id }, { revokedAt: new Date() });

    const response = await request(server())
      .post('/v1/chat/completions')
      .set(bearer(revoked.secret))
      .send(CHAT)
      .expect(401);

    expect(response.body.error.code).toBe('api_key_revoked');
  });

  it('refuses an expired key with its own code', async () => {
    const expired = await createKey(harness.app, workspaceId, { expiresAt: new Date(Date.now() - 1_000) });

    const response = await request(server())
      .post('/v1/chat/completions')
      .set(bearer(expired.secret))
      .send(CHAT)
      .expect(401);

    expect(response.body.error.code).toBe('api_key_expired');
  });

  it('records that an accepted key was used', async () => {
    const fresh = await createKey(harness.app, workspaceId);
    await request(server()).post('/v1/chat/completions').set(bearer(fresh.secret)).send(CHAT).expect(200);

    const stored = await harness.app.get(DataSource).getRepository(ApiKey).findOneByOrFail({ id: fresh.id });
    expect(stored.lastUsedAt).not.toBeNull();
  });

  it('never stores the plaintext of a key', async () => {
    const created = await createKey(harness.app, workspaceId);
    const stored = await harness.app.get(DataSource).getRepository(ApiKey).findOneByOrFail({ id: created.id });

    expect(JSON.stringify(stored)).not.toContain(created.secret.slice(14));
    expect(stored.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.prefix).toBe(ApiKeyService.prefixOf(created.secret));
  });
});

describe('GET /v1/models', () => {
  it('lists the catalogue with pricing and the endpoint that serves it', async () => {
    const response = await request(server()).get('/v1/models').set(bearer(secret)).expect(200);

    expect(response.body.object).toBe('list');
    const chat = response.body.data.find((model: { id: string }) => model.id === 'mock/chat:tdx');
    expect(chat).toMatchObject({
      object: 'model',
      owned_by: 'confidential-router',
      context_length: 4096,
      pricing: { prompt_per_1m_micros: 1_000_000, completion_per_1m_micros: 1_000_000 },
      endpoint: { name: 'mock-primary', hostname: PRIMARY_ENDPOINT_HOSTNAME, tee: 'Intel TDX + H100 CC' },
      capabilities: ['chat', 'completions'],
    });
  });

  it('shows a scoped key only the models it may call', async () => {
    const scoped = await createKey(harness.app, workspaceId, { modelScope: ['mock/scoped:tdx'] });

    const response = await request(server()).get('/v1/models').set(bearer(scoped.secret)).expect(200);

    expect(response.body.data.map((model: { id: string }) => model.id)).toEqual(['mock/scoped:tdx']);
  });

  it('serves a single model whose id contains a slash and a colon', async () => {
    const response = await request(server()).get('/v1/models/mock/chat:tdx').set(bearer(secret)).expect(200);

    expect(response.body.id).toBe('mock/chat:tdx');
  });

  it('answers 404 for a model that is not in the catalogue', async () => {
    const response = await request(server()).get('/v1/models/nobody/nothing:tdx').set(bearer(secret)).expect(404);

    expect(response.body.error.code).toBe('model_not_found');
  });
});

describe('POST /v1/chat/completions', () => {
  it('returns the backend completion under the router s identity', async () => {
    const response = await request(server()).post('/v1/chat/completions').set(bearer(secret)).send(CHAT).expect(200);

    expect(response.body.id).toMatch(/^gen-[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(response.body.model).toBe('mock/chat:tdx');
    expect(response.body.choices).toEqual(COMPLETION_BODY.choices);
  });

  it('extends usage with the cost, the endpoint and the evidence coverage', async () => {
    const response = await request(server()).post('/v1/chat/completions').set(bearer(secret)).send(CHAT).expect(200);

    expect(response.body.usage).toEqual({
      prompt_tokens: 11,
      completion_tokens: 7,
      total_tokens: 18,
      cost_micros: 18,
      endpoint: 'mock-primary',
      // Nothing has published evidence for this endpoint: coverage is absent,
      // which is a fact — never a verdict (ADR-002).
      evidence_digest: null,
    });
  });

  it('names the endpoint that served the request in a header', async () => {
    const response = await request(server()).post('/v1/chat/completions').set(bearer(secret)).send(CHAT).expect(200);

    expect(response.headers['x-confidential-router-endpoint']).toBe(PRIMARY_ENDPOINT_HOSTNAME);
    expect(response.headers['x-confidential-router-generation-id']).toBe(response.body.id);
  });

  it('echoes a client request id', async () => {
    const response = await request(server())
      .post('/v1/chat/completions')
      .set(bearer(secret))
      .set('X-Request-Id', 'req-abc')
      .send(CHAT)
      .expect(200);

    expect(response.headers['x-request-id']).toBe('req-abc');
  });

  it('forwards the backend model name, the credential and unknown fields unchanged', async () => {
    await request(server())
      .post('/v1/chat/completions')
      .set(bearer(secret))
      .send({ ...CHAT, temperature: 0.2, some_future_field: { nested: true } })
      .expect(200);

    expect(upstream.requests).toHaveLength(1);
    const forwarded = upstream.requests[0];
    expect(forwarded.path).toBe('/v1/chat/completions');
    expect(forwarded.body.model).toBe('mock/chat');
    expect(forwarded.body.some_future_field).toEqual({ nested: true });
    expect(forwarded.body.temperature).toBe(0.2);
    expect(forwarded.authorization).toBe('Bearer mock-litellm-key');
    expect(JSON.parse(forwarded.metadata ?? '{}').generation_id).toMatch(/^gen-/);
  });

  it('writes one metering row, with no room for content in it', async () => {
    const response = await request(server()).post('/v1/chat/completions').set(bearer(secret)).send(CHAT).expect(200);

    const row = await generations().findOneByOrFail({ id: response.body.id });
    expect(row).toMatchObject({
      workspaceId,
      apiKeyId: keyId,
      modelId: 'mock/chat:tdx',
      promptTokens: 11,
      completionTokens: 7,
      costMicros: 18,
      promptPer1mMicros: 1_000_000,
      completionPer1mMicros: 1_000_000,
      streamed: false,
      status: 'ok',
      finishReason: 'stop',
      evidenceSnapshotId: null,
    });
    expect(row.latencyMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(row)).not.toContain('Hello there');
  });

  it('adds the cost to the key s running total', async () => {
    const counted = await createKey(harness.app, workspaceId);
    await request(server()).post('/v1/chat/completions').set(bearer(counted.secret)).send(CHAT).expect(200);
    await request(server()).post('/v1/chat/completions').set(bearer(counted.secret)).send(CHAT).expect(200);

    const stored = await harness.app.get(DataSource).getRepository(ApiKey).findOneByOrFail({ id: counted.id });
    expect(stored.spentTotalMicros).toBe(36);
  });

  it('falls back to an estimate when the backend reports no usage', async () => {
    const response = await request(server())
      .post('/v1/chat/completions')
      .set(bearer(secret))
      .send({ model: 'mock/no-usage:tdx', messages: [{ role: 'user', content: 'Hello there, backend.' }] })
      .expect(200);

    const row = await generations().findOneByOrFail({ id: response.body.id });
    expect(row.promptTokens).toBeGreaterThan(0);
    expect(row.costMicros).toBeGreaterThan(0);
  });
});

describe('POST /v1/completions', () => {
  it('serves the legacy route with the same shaping', async () => {
    const response = await request(server())
      .post('/v1/completions')
      .set(bearer(secret))
      .send({ model: 'mock/chat:tdx', prompt: 'Once upon a time' })
      .expect(200);

    expect(response.body.id).toMatch(/^gen-/);
    expect(upstream.requests[0].path).toBe('/v1/completions');
  });
});

describe('POST /v1/embeddings', () => {
  it('serves a model that declares the capability', async () => {
    const response = await request(server())
      .post('/v1/embeddings')
      .set(bearer(secret))
      .send({ model: 'mock/embed:tdx', input: 'embed me' })
      .expect(200);

    expect(response.body.data[0].embedding).toEqual([0.1, 0.2, 0.3]);
    expect(response.body.usage).toMatchObject({ prompt_tokens: 5, cost_micros: 5, endpoint: 'mock-embeddings' });
    expect(response.headers['x-confidential-router-endpoint']).toBe(EMBEDDINGS_ENDPOINT_HOSTNAME);
  });

  it('refuses a model that does not declare it', async () => {
    const response = await request(server())
      .post('/v1/embeddings')
      .set(bearer(secret))
      .send({ model: 'mock/chat:tdx', input: 'embed me' })
      .expect(400);

    expect(response.body.error.code).toBe('unsupported_parameter');
  });
});

describe('GET /v1/generation', () => {
  it('returns the metering record of a generation, and no content', async () => {
    const completion = await request(server()).post('/v1/chat/completions').set(bearer(secret)).send(CHAT).expect(200);

    const response = await request(server())
      .get('/v1/generation')
      .query({ id: completion.body.id })
      .set(bearer(secret))
      .expect(200);

    expect(response.body.data).toMatchObject({
      id: completion.body.id,
      model: 'mock/chat:tdx',
      endpoint: 'mock-primary',
      prompt_tokens: 11,
      completion_tokens: 7,
      total_tokens: 18,
      cost_micros: 18,
      status: 'ok',
      evidence_digest: null,
    });
    expect(JSON.stringify(response.body)).not.toContain('Hello there');
  });

  it('does not reveal another workspace s generation', async () => {
    const completion = await request(server()).post('/v1/chat/completions').set(bearer(secret)).send(CHAT).expect(200);
    const other = await seedWorkspace(harness.app);
    const otherKey = await createKey(harness.app, other.id);

    await request(server())
      .get('/v1/generation')
      .query({ id: completion.body.id })
      .set(bearer(otherKey.secret))
      .expect(404);
  });

  it('needs an id', async () => {
    const response = await request(server()).get('/v1/generation').set(bearer(secret)).expect(400);

    expect(response.body.error.code).toBe('missing_field');
  });
});

describe('unsupported paths', () => {
  it('answers 404 in the OpenAI shape rather than Nest s', async () => {
    const response = await request(server()).post('/v1/moderations').set(bearer(secret)).send({}).expect(404);

    expect(response.body).toEqual({
      error: { message: expect.any(String), type: 'invalid_request_error', code: 'not_found' },
    });
  });
});
