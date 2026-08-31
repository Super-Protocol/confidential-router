/**
 * The OpenAI-compatible surface, against the built router as a process.
 *
 * `apps/router-api/test/v1-*.e2e.spec.ts` already covers the gateway's logic in
 * process. What it cannot cover is the artefact: that `dist/main.js` boots from
 * a configuration file, applies its migrations, binds a socket, and that a real
 * `openai` client talking real HTTP to it gets what the SDK expects. That is
 * what this file is for, so it asserts the things that only break across a
 * process boundary and leaves the rest to the in-process suite.
 */
import { type RouterStack, startRouterStack } from '@confidential-router/demo';
import OpenAI from 'openai';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DEMO_MODEL = 'meta/llama-3.3-70b-instruct:tdx';
const FAILING_MODEL = 'meta/llama-3.3-70b-instruct:broken';

let stack: RouterStack;
let client: OpenAI;

beforeAll(async () => {
  stack = await startRouterStack({
    backendFailures: { 'vllm/broken': { status: 502, message: 'the model is down' } },
  });
  client = new OpenAI({ apiKey: stack.credential.secret, baseURL: `${stack.router.baseUrl}/v1`, maxRetries: 0 });
});

afterAll(async () => {
  await stack?.stop();
});

describe('the built router-api, as a process', () => {
  it('serves its health probe', async () => {
    const response = await request(stack.router.baseUrl).get('/health').expect(200);

    expect(response.body.status).toBe('ok');
  });

  it('lists the configured catalogue at /v1/models', async () => {
    const response = await request(stack.router.baseUrl)
      .get('/v1/models')
      .set('authorization', `Bearer ${stack.credential.secret}`)
      .expect(200);

    expect(response.body.object).toBe('list');
    expect(response.body.data.map((model: { id: string }) => model.id)).toContain(DEMO_MODEL);
  });

  it('refuses an unauthenticated /v1 call', async () => {
    await request(stack.router.baseUrl)
      .post('/v1/chat/completions')
      .send({ model: DEMO_MODEL, messages: [{ role: 'user', content: 'hi' }] })
      .expect(401);
  });

  it('answers a chat completion through the OpenAI SDK', async () => {
    const completion = await client.chat.completions.create({
      model: DEMO_MODEL,
      messages: [{ role: 'user', content: 'Ping from the e2e suite' }],
    });

    expect(completion.model).toBe(DEMO_MODEL);
    expect(completion.choices[0]?.message?.content).toContain('Ping from the e2e suite');
    expect(completion.usage?.total_tokens).toBeGreaterThan(0);
  });

  it('streams a completion the SDK can consume', async () => {
    const stream = await client.chat.completions.create({
      model: DEMO_MODEL,
      messages: [{ role: 'user', content: 'Stream from the e2e suite' }],
      stream: true,
    });

    let text = '';
    let chunks = 0;
    for await (const chunk of stream) {
      chunks += 1;
      text += chunk.choices[0]?.delta?.content ?? '';
    }

    expect(chunks).toBeGreaterThan(1);
    expect(text).toContain('Stream from the e2e suite');
  });

  it('forwards the model the catalogue maps to, not the one the client named', async () => {
    const before = stack.backend.requests.length;

    await client.chat.completions.create({
      model: DEMO_MODEL,
      messages: [{ role: 'user', content: 'Which model reached the backend?' }],
    });

    const forwarded = stack.backend.requests.slice(before);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].body.model).toBe('vllm/llama-3.3-70b-instruct');
    // The workspace's credential must never reach the backend.
    expect(forwarded[0].authorization ?? '').not.toContain(stack.credential.secret);
  });

  it('reports a model that is not in the catalogue as a 404, not a 502', async () => {
    const response = await request(stack.router.baseUrl)
      .post('/v1/chat/completions')
      .set('authorization', `Bearer ${stack.credential.secret}`)
      .send({ model: 'nobody/such-model', messages: [{ role: 'user', content: 'hi' }] })
      .expect(404);

    expect(response.body.error.code).toBe('model_not_found');
  });

  it('surfaces a backend failure as an upstream error', async () => {
    const response = await request(stack.router.baseUrl)
      .post('/v1/chat/completions')
      .set('authorization', `Bearer ${stack.credential.secret}`)
      .send({ model: FAILING_MODEL, messages: [{ role: 'user', content: 'hi' }] });

    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(response.body.error).toBeDefined();
  });

  it('stops honouring a key the console revoked', async () => {
    const created = await stack.session.graphql<{ createApiKey: { secret: string; key: { id: string } } }>(
      'mutation NewKey($input: CreateApiKeyInput!) { createApiKey(input: $input) { secret key { id } } }',
      { input: { workspaceId: stack.session.workspaceId, name: 'Short-lived' } },
    );

    await request(stack.router.baseUrl)
      .post('/v1/chat/completions')
      .set('authorization', `Bearer ${created.createApiKey.secret}`)
      .send({ model: DEMO_MODEL, messages: [{ role: 'user', content: 'hi' }] })
      .expect(200);

    await stack.session.graphql('mutation Revoke($id: ID!) { revokeApiKey(id: $id) { id revokedAt } }', {
      id: created.createApiKey.key.id,
    });

    await request(stack.router.baseUrl)
      .post('/v1/chat/completions')
      .set('authorization', `Bearer ${created.createApiKey.secret}`)
      .send({ model: DEMO_MODEL, messages: [{ role: 'user', content: 'hi' }] })
      .expect(401);
  });
});
