import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WorkspaceMember } from '../src/app/db/entities/workspace-member.entity.js';
import { createHarness, type Harness } from './app-harness.js';
import { bearer, createKey, routerConfigFor, seedWorkspace } from './gateway-fixture.js';
import { MockLiteLlm } from './mock-litellm.js';

/**
 * `model_requested`, end to end — SUP-542.
 *
 * The event the first invitation batch needs and the router did not have. Its
 * value is in the refusals: `unknown_model` is the only record anywhere that
 * somebody asked for a model we do not serve, because admission throws before a
 * generation id exists and the request leaves no row behind.
 *
 * The capture is not awaited by the request, on purpose — a refusal must not be
 * answered more slowly because of a chart — so every case here waits for the
 * event rather than assuming the response implied it.
 */

const upstream = new MockLiteLlm();

const CHAT = { model: 'mock/chat:tdx', messages: [{ role: 'user', content: 'Hello there' }] };

let harness: Harness;
let secret: string;
let workspaceId: string;
let ownerId: string;

beforeAll(async () => {
  const baseUrl = await upstream.start();
  harness = await createHarness({ config: routerConfigFor(baseUrl) });
  const workspace = await seedWorkspace(harness.app);
  workspaceId = workspace.id;
  ownerId = randomUUID();
  await harness.app
    .get(DataSource)
    .getRepository(WorkspaceMember)
    .save({ workspaceId, userId: ownerId, role: 'owner', createdAt: new Date() });
  secret = (await createKey(harness.app, workspaceId)).secret;
}, 60_000);

afterAll(async () => {
  await harness?.close();
  await upstream.stop();
});

beforeEach(() => {
  upstream.reset();
  harness.events.reset();
});

function server() {
  return harness.app.getHttpServer();
}

function post(body: Record<string, unknown>, path = '/v1/chat/completions') {
  return request(server()).post(path).set(bearer(secret)).send(body);
}

describe('a model the router serves', () => {
  it('reports the slug, the result and the route, attributed to the account', async () => {
    await post(CHAT).expect(200);

    const [event] = await harness.events.waitFor('model_requested');
    expect(event.properties).toEqual({ model_slug: 'mock/chat:tdx', result: 'served', route: 'chat' });
    // The same id space as every other event about this account: two would show
    // one person as two in PostHog.
    expect(event.distinctId).toBe(ownerId);
    expect(event.anonymous).toBe(false);
  });

  it('reports every request, not only the workspace’s first', async () => {
    await post(CHAT).expect(200);
    await post(CHAT).expect(200);

    // "How often" is the question this one answers, which is why it is per
    // request. `first_request_sent` was spent on this workspace's first
    // generation and says nothing about either of these two.
    await harness.events.waitFor('model_requested', 2);
    expect(harness.events.all('first_request_sent')).toHaveLength(0);
  });

  it('names the route the request came in on', async () => {
    await post({ model: 'mock/embed:tdx', input: 'embed me' }, '/v1/embeddings').expect(200);

    const [event] = await harness.events.waitFor('model_requested');
    expect(event.properties).toMatchObject({ model_slug: 'mock/embed:tdx', route: 'embeddings' });
  });
});

describe('a model the router does not serve', () => {
  it('records the demand that leaves no other trace', async () => {
    const before = await generationCount();
    const response = await post({ ...CHAT, model: 'openai/gpt-5-turbo' }).expect(404);

    expect(response.body.error.code).toBe('model_not_found');
    const [event] = await harness.events.waitFor('model_requested');
    // The roadmap signal, and the whole reason the event sits before admission
    // rather than after it.
    expect(event.properties).toEqual({
      model_slug: 'openai/gpt-5-turbo',
      result: 'unknown_model',
      route: 'chat',
    });
    // Admission throws before a generation id exists, so the event is the only
    // record of this request anywhere.
    expect(await generationCount()).toBe(before);
  });

  it('reports a model this key may not call as a scope refusal, not as missing demand', async () => {
    const scoped = await createKey(harness.app, workspaceId, { modelScope: ['mock/chat:tdx'] });

    await request(server())
      .post('/v1/chat/completions')
      .set(bearer(scoped.secret))
      .send({ ...CHAT, model: 'mock/scoped:tdx' })
      .expect(403);

    const [event] = await harness.events.waitFor('model_requested');
    // A model we do have, called with a key not scoped to it. Filing it as
    // `unknown_model` would put a phantom gap in the catalogue report.
    expect(event.properties).toMatchObject({ model_slug: 'mock/scoped:tdx', result: 'out_of_key_scope' });
  });

  it('reports a route the model does not serve', async () => {
    await post({ model: 'mock/embed:tdx', messages: CHAT.messages }).expect(400);

    const [event] = await harness.events.waitFor('model_requested');
    expect(event.properties).toMatchObject({ model_slug: 'mock/embed:tdx', result: 'unsupported_route' });
  });
});

describe('what never becomes an event', () => {
  it('says nothing when the request named no model', async () => {
    await post({ messages: CHAT.messages }).expect(400);

    // A client bug with no demand in it. An event would be a row that says
    // nothing about which models people want.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(harness.events.all('model_requested')).toHaveLength(0);
  });

  it('does not file a request-shape refusal as demand for the model', async () => {
    await post({ ...CHAT, n: 2 }).expect(400);

    // `n > 1` shares its error code with the route refusal and says nothing about
    // the model.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(harness.events.all('model_requested')).toHaveLength(0);
  });

  it('carries nothing from the request but the model field', async () => {
    await post({
      model: 'mock/chat:tdx',
      messages: [{ role: 'user', content: 'my passport number is 123456789' }],
    }).expect(200);

    const [event] = await harness.events.waitFor('model_requested');
    expect(JSON.stringify(event)).not.toContain('passport');
    expect(Object.keys(event.properties).sort()).toEqual(['model_slug', 'result', 'route']);
  });

  it('files prose in the model field as one row rather than a row of its own', async () => {
    await post({ ...CHAT, model: 'please use whichever model is cheapest today' }).expect(404);

    const [event] = await harness.events.waitFor('model_requested');
    expect(event.properties.model_slug).toBe('unparseable');
  });
});

async function generationCount(): Promise<number> {
  const { Generation } = await import('../src/app/db/entities/generation.entity.js');
  return harness.app.get(DataSource).getRepository(Generation).count();
}
