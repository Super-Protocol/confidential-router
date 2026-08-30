import request from 'supertest';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Workspace } from '../src/app/db/entities/workspace.entity.js';
import { createHarness, type Harness, signIn } from './app-harness.js';
import { bearer, routerConfigFor } from './gateway-fixture.js';
import { MockLiteLlm } from './mock-litellm.js';

const upstream = new MockLiteLlm();

let harness: Harness;
let cookies: string[];
let workspaceId: string;

const ME = '{ me { workspaces { id } } }';

const CREATE = `mutation Create($input: CreateApiKeyInput!) {
  createApiKey(input: $input) {
    secret
    key { id name prefix modelScope spendLimitMicros spentTotalMicros requestsPerMinute expiresAt revokedAt createdAt }
  }
}`;

const LIST =
  'query List($workspaceId: ID!) { apiKeys(workspaceId: $workspaceId) { id name prefix modelScope revokedAt lastUsedAt } }';

const UPDATE = `mutation Update($id: ID!, $input: UpdateApiKeyInput!) {
  updateApiKey(id: $id, input: $input) { id name modelScope spendLimitMicros requestsPerMinute }
}`;

const REVOKE = 'mutation Revoke($id: ID!) { revokeApiKey(id: $id) { id revokedAt } }';

beforeAll(async () => {
  const baseUrl = await upstream.start();
  harness = await createHarness({ config: routerConfigFor(baseUrl) });
  cookies = await signIn(harness, 'keys@example.com');
  const me = await gql(ME, {}, cookies);
  workspaceId = me.body.data.me.workspaces[0].id;
  // A personal workspace starts at zero credit, and a key with no credit behind
  // it cannot demonstrate that it works.
  await harness.app.get(DataSource).getRepository(Workspace).update({ id: workspaceId }, { balanceMicros: 1_000_000 });
}, 60_000);

afterAll(async () => {
  await harness?.close();
  await upstream.stop();
});

function gql(query: string, variables: Record<string, unknown> = {}, session: string[] = []) {
  const call = request(harness.app.getHttpServer()).post('/graphql');
  return (session.length > 0 ? call.set('Cookie', session) : call).send({ query, variables });
}

async function createKey(input: Record<string, unknown> = {}) {
  const response = await gql(CREATE, { input: { workspaceId, name: 'CI key', ...input } }, cookies);
  expect(response.body.errors, JSON.stringify(response.body.errors)).toBeUndefined();
  return response.body.data.createApiKey as { secret: string; key: Record<string, unknown> };
}

describe('createApiKey', () => {
  it('returns a usable secret, once, alongside the stored record', async () => {
    const created = await createKey({ name: 'Production' });

    expect(created.secret).toMatch(/^sk-tee-v1-[A-Za-z0-9_-]{43}$/);
    expect(created.key).toMatchObject({
      name: 'Production',
      prefix: created.secret.slice(0, 12),
      modelScope: null,
      spendLimitMicros: null,
      spentTotalMicros: '0',
      revokedAt: null,
    });

    await request(harness.app.getHttpServer())
      .post('/v1/chat/completions')
      .set(bearer(created.secret))
      .send({ model: 'mock/chat:tdx', messages: [{ role: 'user', content: 'hi' }] })
      .expect(200);
  });

  it('never exposes the secret again', async () => {
    const created = await createKey();

    const listed = await gql(LIST, { workspaceId }, cookies);
    expect(JSON.stringify(listed.body)).not.toContain(created.secret);
    expect(listed.body.data.apiKeys.map((key: { id: string }) => key.id)).toContain(created.key.id);
  });

  it('stores the settings the console sent', async () => {
    const created = await createKey({
      name: 'Scoped',
      modelIds: ['mock/chat:tdx'],
      spendLimitMicros: '250000',
      requestsPerMinute: 30,
      expiresAt: '2027-01-01T00:00:00.000Z',
    });

    expect(created.key).toMatchObject({
      modelScope: ['mock/chat:tdx'],
      spendLimitMicros: '250000',
      requestsPerMinute: 30,
      expiresAt: '2027-01-01T00:00:00.000Z',
    });
  });

  it('refuses a scope naming a model that does not exist', async () => {
    const response = await gql(
      CREATE,
      { input: { workspaceId, name: 'Bad scope', modelIds: ['nobody/nothing:tdx'] } },
      cookies,
    );

    expect(response.body.errors?.[0]?.message).toContain('Unknown model id');
  });

  it('refuses a workspace the caller does not belong to', async () => {
    const stranger = await signIn(harness, 'stranger@example.com');

    const response = await gql(CREATE, { input: { workspaceId, name: 'Theirs' } }, stranger);

    expect(response.body.errors?.[0]?.message).toContain('do not have access');
  });

  it('is refused without a session', async () => {
    const response = await gql(CREATE, { input: { workspaceId, name: 'Anonymous' } });

    expect(response.body.errors?.[0]?.message).toContain('Authentication is required');
  });
});

describe('apiKeys', () => {
  it('lists the workspace s keys and nothing else', async () => {
    const stranger = await signIn(harness, 'other-tenant@example.com');
    const strangerWorkspace = (await gql(ME, {}, stranger)).body.data.me.workspaces[0].id;

    const mine = await gql(LIST, { workspaceId }, cookies);
    const theirs = await gql(LIST, { workspaceId: strangerWorkspace }, stranger);

    expect(mine.body.data.apiKeys.length).toBeGreaterThan(0);
    expect(theirs.body.data.apiKeys).toEqual([]);
  });

  it('refuses to list another tenant s keys', async () => {
    const stranger = await signIn(harness, 'nosy@example.com');

    const response = await gql(LIST, { workspaceId }, stranger);

    expect(response.body.errors?.[0]?.message).toContain('do not have access');
  });
});

describe('updateApiKey', () => {
  it('changes only the fields the caller sent', async () => {
    const created = await createKey({ name: 'Before', requestsPerMinute: 10 });

    const response = await gql(UPDATE, { id: created.key.id, input: { name: 'After' } }, cookies);

    expect(response.body.data.updateApiKey).toMatchObject({ name: 'After', requestsPerMinute: 10 });
  });

  it('replaces the scope, and an empty list clears it', async () => {
    const created = await createKey({ modelIds: ['mock/chat:tdx'] });

    const narrowed = await gql(UPDATE, { id: created.key.id, input: { modelIds: ['mock/scoped:tdx'] } }, cookies);
    expect(narrowed.body.data.updateApiKey.modelScope).toEqual(['mock/scoped:tdx']);

    const cleared = await gql(UPDATE, { id: created.key.id, input: { modelIds: [] } }, cookies);
    expect(cleared.body.data.updateApiKey.modelScope).toBeNull();
  });

  it('refuses a key belonging to another tenant', async () => {
    const created = await createKey();
    const stranger = await signIn(harness, 'thief@example.com');

    const response = await gql(UPDATE, { id: created.key.id, input: { name: 'Mine now' } }, stranger);

    expect(response.body.errors?.[0]?.message).toContain('not found');
  });
});

describe('revokeApiKey', () => {
  it('stamps the key and stops it working immediately', async () => {
    const created = await createKey();

    const response = await gql(REVOKE, { id: created.key.id }, cookies);
    expect(response.body.data.revokeApiKey.revokedAt).not.toBeNull();

    const refused = await request(harness.app.getHttpServer())
      .post('/v1/chat/completions')
      .set(bearer(created.secret))
      .send({ model: 'mock/chat:tdx', messages: [] })
      .expect(401);
    expect(refused.body.error.code).toBe('api_key_revoked');
  });

  it('is idempotent and keeps the original timestamp', async () => {
    const created = await createKey();

    const first = await gql(REVOKE, { id: created.key.id }, cookies);
    const second = await gql(REVOKE, { id: created.key.id }, cookies);

    expect(second.body.data.revokeApiKey.revokedAt).toBe(first.body.data.revokeApiKey.revokedAt);
  });

  it('keeps the revoked key visible, because its generations still point at it', async () => {
    const created = await createKey({ name: 'Retired' });
    await gql(REVOKE, { id: created.key.id }, cookies);

    const listed = await gql(LIST, { workspaceId }, cookies);
    const key = listed.body.data.apiKeys.find((candidate: { id: string }) => candidate.id === created.key.id);
    expect(key.revokedAt).not.toBeNull();
  });
});
