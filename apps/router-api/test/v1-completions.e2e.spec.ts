import request from 'supertest';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { servedCapabilities } from '../src/app/catalog/served-capabilities.js';
import { Generation } from '../src/app/db/entities/generation.entity.js';
import { createHarness, type Harness } from './app-harness.js';
import { bearer, createKey, routerConfigFor, seedWorkspace } from './gateway-fixture.js';
import { MockLiteLlm } from './mock-litellm.js';

/**
 * `POST /v1/completions`, both ways it is served, and the conformance rule that
 * keeps the catalogue honest about it (SUP-450).
 *
 * The legacy route is in the contract's required list and used to answer 400 for
 * every chat-only model — which is nearly every registration, since `chat` is the
 * default. Continue prompts this route for its *apply* and *autocomplete* roles,
 * so the refusal reached users as "Failed to edit <file>" and a retry loop
 * (SUP-447).
 */

const upstream = new MockLiteLlm();

let harness: Harness;
let secret: string;
let workspaceId: string;

beforeAll(async () => {
  const baseUrl = await upstream.start();
  harness = await createHarness({ config: routerConfigFor(baseUrl) });
  const workspace = await seedWorkspace(harness.app);
  workspaceId = workspace.id;
  secret = (await createKey(harness.app, workspaceId)).secret;
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

/** The data payloads of an SSE body, `[DONE]` and comment lines excluded. */
function streamedChunks(body: string): Record<string, unknown>[] {
  return body
    .split('\n\n')
    .map((event) => event.replace(/^data: /m, '').trim())
    .filter((payload) => payload.length > 0 && payload !== '[DONE]' && !payload.startsWith(':'))
    .map((payload) => JSON.parse(payload) as Record<string, unknown>);
}

describe('POST /v1/completions for a chat-only model', () => {
  it('answers a text_completion under the router’s identity', async () => {
    const response = await request(server())
      .post('/v1/completions')
      .set(bearer(secret))
      .send({ model: 'mock/chat-only:tdx', prompt: 'def add(a, b):', max_tokens: 16 })
      .expect(200);

    expect(response.body).toMatchObject({
      object: 'text_completion',
      model: 'mock/chat-only:tdx',
      choices: [{ index: 0, text: 'Hello world', logprobs: null, finish_reason: 'stop' }],
    });
    expect(response.body.id).toMatch(/^gen-/);
    // The same metering and the same extension fields as every other route:
    // nothing between the two translations knows this request was legacy.
    expect(response.body.usage).toMatchObject({
      prompt_tokens: 11,
      completion_tokens: 7,
      cost_micros: 18,
      endpoint: 'mock-primary',
    });
  });

  it('forwards it to the chat route as one user message, prompt dropped', async () => {
    await request(server())
      .post('/v1/completions')
      .set(bearer(secret))
      .send({ model: 'mock/chat-only:tdx', prompt: 'def add(a, b):', temperature: 0 })
      .expect(200);

    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]).toMatchObject({
      path: '/v1/chat/completions',
      body: {
        // Rewritten to the name the backend knows, as on every route.
        model: 'mock/chat',
        messages: [{ role: 'user', content: 'def add(a, b):' }],
        temperature: 0,
      },
    });
    expect(upstream.requests[0].body).not.toHaveProperty('prompt');
  });

  it('meters it as one ordinary generation', async () => {
    const response = await request(server())
      .post('/v1/completions')
      .set(bearer(secret))
      .send({ model: 'mock/chat-only:tdx', prompt: 'hello' })
      .expect(200);

    const row = await generations().findOneByOrFail({ id: response.body.id });
    expect(row).toMatchObject({
      modelId: 'mock/chat-only:tdx',
      status: 'ok',
      promptTokens: 11,
      completionTokens: 7,
      finishReason: 'stop',
    });
  });

  it('streams it as text_completion chunks, then [DONE]', async () => {
    const response = await request(server())
      .post('/v1/completions')
      .set(bearer(secret))
      .send({ model: 'mock/chat-only:tdx', prompt: 'hello', stream: true })
      .expect(200);

    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.text).toContain('data: [DONE]');
    const chunks = streamedChunks(response.text);
    expect(chunks.every((chunk) => chunk.object === 'text_completion')).toBe(true);
    expect(chunks.map((chunk) => (chunk.choices as { text: string }[])[0].text).join('')).toBe(
      'Hello wörld ✨\nsecond line',
    );
    // The usage chunk the router asked for on its own behalf is still dropped:
    // the client did not ask for one, and the translation did not hide it.
    expect(chunks.some((chunk) => (chunk.choices as unknown[]).length === 0)).toBe(false);
  });

  it('records the streamed generation with the backend’s own counts', async () => {
    const response = await request(server())
      .post('/v1/completions')
      .set(bearer(secret))
      .send({ model: 'mock/chat-only:tdx', prompt: 'hello', stream: true })
      .expect(200);

    const id = response.headers['x-confidential-router-generation-id'];
    const row = await generations().findOneByOrFail({ id });
    expect(row).toMatchObject({ status: 'ok', promptTokens: 11, completionTokens: 7, finishReason: 'stop' });
  });

  /*
   * SUP-424's hole, re-opened by the translation and closed again: a legacy
   * chunk can carry assistant text and nothing else, so a `tool_calls` delta is
   * already `text: ''` once translated. Measuring there left a bridged agent
   * turn with no first-token time at all, which is half the streamed rows in
   * Logs for anything that calls tools. The relay measures the upstream chunk
   * and emits the translated one.
   */
  it('still times the first token of a turn that only calls tools', async () => {
    const response = await request(server())
      .post('/v1/completions')
      .set(bearer(secret))
      .send({ model: 'mock/stream-tools:tdx', prompt: 'read the file', stream: true })
      .expect(200);

    const chunks = streamedChunks(response.text);
    // Translated for the client: a legacy reader gets `text` and no `delta`, so
    // the tool call itself is not expressible — `finish_reason: "tool_calls"`
    // still is, and still says why the turn ended.
    expect(chunks.every((chunk) => chunk.object === 'text_completion')).toBe(true);
    const choices = chunks.flatMap((chunk) => chunk.choices as Record<string, unknown>[]);
    expect(choices.every((choice) => 'text' in choice && !('delta' in choice))).toBe(true);
    expect(choices.some((choice) => choice.finish_reason === 'tool_calls')).toBe(true);

    const row = await generations().findOneByOrFail({
      id: response.headers['x-confidential-router-generation-id'],
    });
    expect(row.timeToFirstTokenMs).not.toBeNull();
    expect(row.timeToFirstTokenMs ?? -1).toBeGreaterThan(0);
    expect(row.finishReason).toBe('tool_calls');
  });

  it('forwards no legacy-only parameter the chat route has no place for', async () => {
    // Accepted because they ask for nothing, dropped because three of them do
    // not exist on the chat route and `logprobs` exists with another type. A
    // strict upstream would answer 400 to a request the bridge just accepted.
    await request(server())
      .post('/v1/completions')
      .set(bearer(secret))
      .send({ model: 'mock/chat-only:tdx', prompt: 'at end of file', suffix: '', echo: false, best_of: 1 })
      .expect(200);

    const forwarded = upstream.requests[0].body;
    expect(forwarded).toMatchObject({ messages: [{ role: 'user', content: 'at end of file' }] });
    for (const param of ['suffix', 'echo', 'best_of', 'prompt']) {
      expect(forwarded).not.toHaveProperty(param);
    }
  });

  it('refuses an infilling request by name, and forwards nothing', async () => {
    const response = await request(server())
      .post('/v1/completions')
      .set(bearer(secret))
      .send({ model: 'mock/chat-only:tdx', prompt: 'head', suffix: 'tail' })
      .expect(400);

    expect(response.body.error).toMatchObject({ code: 'unsupported_parameter', param: 'suffix' });
    expect(upstream.requests).toHaveLength(0);
  });

  it('does not meter a request it refused before forwarding', async () => {
    const before = await generations().count();

    await request(server())
      .post('/v1/completions')
      .set(bearer(secret))
      .send({ model: 'mock/chat-only:tdx', prompt: ['one', 'two'] })
      .expect(400);

    expect(await generations().count()).toBe(before);
  });
});

describe('POST /v1/completions for a model whose backend serves it', () => {
  it('forwards the prompt verbatim to the backend’s own legacy route', async () => {
    const response = await request(server())
      .post('/v1/completions')
      .set(bearer(secret))
      // `mock/chat:tdx` declares [chat, completions]; nothing is translated.
      .send({ model: 'mock/chat:tdx', prompt: 'def add(a, b):', suffix: '    return c' })
      .expect(200);

    expect(upstream.requests[0]).toMatchObject({
      path: '/v1/completions',
      body: { model: 'mock/chat', prompt: 'def add(a, b):', suffix: '    return c' },
    });
    expect(upstream.requests[0].body).not.toHaveProperty('messages');
    expect(response.body).toMatchObject({
      object: 'text_completion',
      model: 'mock/chat:tdx',
      choices: [{ index: 0, text: 'native legacy text', finish_reason: 'stop' }],
    });
  });

  it('relays its stream without touching the chunks', async () => {
    const response = await request(server())
      .post('/v1/completions')
      .set(bearer(secret))
      .send({ model: 'mock/chat:tdx', prompt: 'hello', stream: true })
      .expect(200);

    const chunks = streamedChunks(response.text);
    expect(chunks.map((chunk) => (chunk.choices as { text: string }[])[0].text).join('')).toBe('native legacy');
    expect(chunks.every((chunk) => chunk.object === 'text_completion')).toBe(true);
  });
});

/**
 * The rule the catalogue is for: a client reading `capabilities` learns exactly
 * which routes it may call, with no route left out and none promised that is
 * not there.
 */
describe('GET /v1/models conformance', () => {
  const ROUTES = {
    chat: { path: '/v1/chat/completions', body: { messages: [{ role: 'user', content: 'hi' }] } },
    completions: { path: '/v1/completions', body: { prompt: 'hi' } },
    embeddings: { path: '/v1/embeddings', body: { input: 'hi' } },
  } as const;

  // One model per declarable shape, all three backed by a mock that answers
  // rather than hangs: chat and the legacy route declared, chat alone, and
  // embeddings alone.
  const MODELS = ['mock/chat:tdx', 'mock/chat-only:tdx', 'mock/embed:tdx'] as const;

  it('reports the derived list, not the declared one', async () => {
    const response = await request(server()).get('/v1/models').set(bearer(secret)).expect(200);
    const listed = new Map<string, string[]>(
      response.body.data.map((model: { id: string; capabilities: string[] }) => [model.id, model.capabilities]),
    );

    expect(listed.get('mock/chat-only:tdx')).toEqual(servedCapabilities(['chat']));
    expect(listed.get('mock/chat:tdx')).toEqual(servedCapabilities(['chat', 'completions']));
    expect(listed.get('mock/embed:tdx')).toEqual(servedCapabilities(['embeddings']));
  });

  for (const model of MODELS) {
    for (const [route, { path, body }] of Object.entries(ROUTES)) {
      it(`accepts ${path} for ${model} exactly when it lists "${route}"`, async () => {
        const listed = await request(server()).get(`/v1/models/${model}`).set(bearer(secret)).expect(200);
        const claimed = (listed.body.capabilities as string[]).includes(route);

        const response = await request(server())
          .post(path)
          .set(bearer(secret))
          .send({ model, ...body });

        // A capability refusal is the one answer that means "not served". Any
        // other outcome — a completion, or a backend failure — means the route
        // was accepted and the request left the router.
        const refused = response.status === 400 && response.body.error?.param === 'model';
        expect(refused).toBe(!claimed);
      });
    }
  }
});
