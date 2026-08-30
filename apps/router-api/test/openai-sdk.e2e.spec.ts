import OpenAI, { APIError } from 'openai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness, listen } from './app-harness.js';
import { createKey, routerConfigFor, seedWorkspace } from './gateway-fixture.js';
import { MockLiteLlm } from './mock-litellm.js';

/**
 * The promise the product makes is "change one base URL". This suite is the
 * only place that checks it against the real thing: the official `openai`
 * client, unmodified, pointed at a running router.
 *
 * It is deliberately about the SDK's own expectations — that the envelope
 * validates, that streaming yields chunks, that a 4xx becomes an `APIError`
 * with the right code — rather than about the router's internals, which the
 * other suites cover.
 */

const upstream = new MockLiteLlm();

let harness: Harness;
let client: OpenAI;

beforeAll(async () => {
  const upstreamUrl = await upstream.start();
  harness = await createHarness({ config: routerConfigFor(upstreamUrl) });
  const baseUrl = await listen(harness);
  const workspace = await seedWorkspace(harness.app);
  const key = await createKey(harness.app, workspace.id);

  client = new OpenAI({ apiKey: key.secret, baseURL: `${baseUrl}/v1`, maxRetries: 0 });
}, 60_000);

afterAll(async () => {
  await harness?.close();
  await upstream.stop();
});

describe('the openai SDK against a running router', () => {
  it('lists models', async () => {
    const models = await client.models.list();

    expect(models.data.map((model) => model.id)).toContain('mock/chat:tdx');
  });

  it('completes a chat request', async () => {
    const completion = await client.chat.completions.create({
      model: 'mock/chat:tdx',
      messages: [{ role: 'user', content: 'Hello there' }],
    });

    expect(completion.id).toMatch(/^gen-/);
    expect(completion.model).toBe('mock/chat:tdx');
    expect(completion.choices[0].message.content).toBe('Hello world');
    expect(completion.usage).toMatchObject({ prompt_tokens: 11, completion_tokens: 7 });
    // The router's extensions ride inside `usage`, where the SDK passes them
    // through untouched instead of rejecting the envelope.
    expect((completion.usage as unknown as { cost_micros: number }).cost_micros).toBe(18);
  });

  it('streams a chat request chunk by chunk', async () => {
    const stream = await client.chat.completions.create({
      model: 'mock/chat:tdx',
      messages: [{ role: 'user', content: 'Hello there' }],
      stream: true,
    });

    const deltas: string[] = [];
    for await (const chunk of stream) {
      deltas.push(chunk.choices[0]?.delta?.content ?? '');
      expect(chunk.id).toMatch(/^gen-/);
    }

    expect(deltas.join('')).toBe('Hello wörld ✨\nsecond line');
  });

  it('streams with usage when asked for it', async () => {
    const stream = await client.chat.completions.create({
      model: 'mock/chat:tdx',
      messages: [{ role: 'user', content: 'Hello there' }],
      stream: true,
      stream_options: { include_usage: true },
    });

    let usage: { total_tokens?: number } | undefined;
    for await (const chunk of stream) {
      usage = chunk.usage ?? usage;
    }

    expect(usage?.total_tokens).toBe(18);
  });

  it('creates embeddings', async () => {
    // `encoding_format` is explicit because the SDK otherwise asks for base64
    // and decodes the answer; the mock backend answers in floats. The router
    // forwards the field either way, which is the part under test.
    const embeddings = await client.embeddings.create({
      model: 'mock/embed:tdx',
      input: 'embed me',
      encoding_format: 'float',
    });

    expect(embeddings.data[0].embedding).toEqual([0.1, 0.2, 0.3]);
    expect((embeddings.usage as unknown as { cost_micros: number }).cost_micros).toBe(5);
  });

  it('surfaces a router error as an APIError the SDK understands', async () => {
    const failure = await client.chat.completions
      .create({ model: 'nobody/nothing:tdx', messages: [{ role: 'user', content: 'hi' }] })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(APIError);
    const error = failure as APIError;
    expect(error.status).toBe(404);
    expect(error.code).toBe('model_not_found');
    expect(error.type).toBe('invalid_request_error');
  });

  it('surfaces an authentication failure as the SDK s own AuthenticationError', async () => {
    const anonymous = new OpenAI({ apiKey: 'sk-tee-v1-nope', baseURL: client.baseURL, maxRetries: 0 });

    const failure = await anonymous.models.list().catch((error: unknown) => error);

    expect((failure as APIError).status).toBe(401);
    expect((failure as APIError).code).toBe('invalid_api_key');
  });
});
