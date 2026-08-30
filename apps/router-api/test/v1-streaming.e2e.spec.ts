import { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Generation } from '../src/app/db/entities/generation.entity.js';
import { createHarness, type Harness, listen } from './app-harness.js';
import { bearer, createKey, PRIMARY_ENDPOINT_HOSTNAME, routerConfigFor, seedWorkspace } from './gateway-fixture.js';
import { MockLiteLlm, STREAM_CHUNKS } from './mock-litellm.js';

const upstream = new MockLiteLlm();

let harness: Harness;
let baseUrl: string;
let secret: string;

beforeAll(async () => {
  const upstreamUrl = await upstream.start();
  harness = await createHarness({ config: routerConfigFor(upstreamUrl) });
  baseUrl = await listen(harness);
  const workspace = await seedWorkspace(harness.app);
  secret = (await createKey(harness.app, workspace.id)).secret;
}, 60_000);

afterAll(async () => {
  await harness?.close();
  await upstream.stop();
});

beforeEach(() => {
  upstream.reset();
});

interface StreamResult {
  response: Response;
  /** Raw event blocks, exactly as they arrived. */
  events: string[];
  /** The JSON payloads among them, in order. */
  chunks: Record<string, unknown>[];
}

async function stream(body: Record<string, unknown>): Promise<StreamResult> {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...bearer(secret) },
    body: JSON.stringify({ stream: true, ...body }),
  });
  const text = await response.text();
  const events = text
    .split('\n\n')
    .filter((event) => event.length > 0)
    .map((event) => `${event}\n\n`);
  const chunks = events
    .map((event) => event.replace(/^data: /, '').trim())
    .filter((payload) => payload.startsWith('{'))
    .map((payload) => JSON.parse(payload) as Record<string, unknown>);
  return { response, events, chunks };
}

function generations() {
  return harness.app.get(DataSource).getRepository(Generation);
}

const CHAT = { model: 'mock/chat:tdx', messages: [{ role: 'user', content: 'Hello there' }] };

describe('streaming responses', () => {
  it('is served as an unbuffered event stream', async () => {
    const { response } = await stream(CHAT);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('cache-control')).toContain('no-transform');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    expect(response.headers.get('x-confidential-router-endpoint')).toBe(PRIMARY_ENDPOINT_HOSTNAME);
    expect(response.headers.get('x-confidential-router-generation-id')).toMatch(/^gen-/);
  });

  it('forwards every chunk the backend produced, byte for byte apart from the identity fields', async () => {
    const { chunks, response } = await stream(CHAT);
    const generationId = response.headers.get('x-confidential-router-generation-id');

    // A partial event, unicode and an embedded newline all cross the relay here
    // — `mock/chat` splits its second event across two TCP writes.
    expect(chunks).toEqual(STREAM_CHUNKS.map((chunk) => ({ ...chunk, id: generationId, model: 'mock/chat:tdx' })));
  });

  it('terminates with [DONE]', async () => {
    const { events } = await stream(CHAT);

    expect(events.at(-1)).toBe('data: [DONE]\n\n');
  });

  it('does not add a usage chunk the client did not ask for', async () => {
    const { chunks } = await stream(CHAT);

    expect(chunks.some((chunk) => 'usage' in chunk)).toBe(false);
  });

  it('meters the exact backend usage even when the client never sees it', async () => {
    const { response } = await stream(CHAT);
    const id = response.headers.get('x-confidential-router-generation-id') as string;

    // The router asked the backend for usage on its own behalf; the numbers are
    // the backend's, not an estimate.
    const row = await generations().findOneByOrFail({ id });
    expect(row).toMatchObject({ promptTokens: 11, completionTokens: 7, costMicros: 18, streamed: true, status: 'ok' });
    expect(JSON.parse(upstream.requests[0].metadata ?? '{}').generation_id).toBe(id);
    expect(upstream.requests[0].body.stream_options).toEqual({ include_usage: true });
  });

  it('sends the usage chunk, extended, when the client does ask for it', async () => {
    const { chunks } = await stream({ ...CHAT, stream_options: { include_usage: true } });

    const usageChunk = chunks.find((chunk) => 'usage' in chunk);
    expect(usageChunk?.choices).toEqual([]);
    expect(usageChunk?.usage).toEqual({
      prompt_tokens: 11,
      completion_tokens: 7,
      total_tokens: 18,
      cost_micros: 18,
      endpoint: 'mock-primary',
      evidence_digest: null,
    });
  });

  it('records the time to first token and the generation rate', async () => {
    const { response } = await stream(CHAT);
    const id = response.headers.get('x-confidential-router-generation-id') as string;

    const row = await generations().findOneByOrFail({ id });
    expect(row.timeToFirstTokenMs).not.toBeNull();
    expect(row.timeToFirstTokenMs ?? -1).toBeGreaterThanOrEqual(0);
    expect(row.tokensPerSecond ?? 0).toBeGreaterThan(0);
    expect(row.finishReason).toBe('stop');
  });

  it('reports a backend that dies mid-stream in the stream itself, then terminates it', async () => {
    const { events, chunks, response } = await stream({ ...CHAT, model: 'mock/stream-abort:tdx' });

    expect(response.status).toBe(200);
    const failure = chunks.find((chunk) => 'error' in chunk) as { error: { type: string; code: string } } | undefined;
    expect(failure?.error.type).toBe('server_error');
    expect(events.at(-1)).toBe('data: [DONE]\n\n');

    const id = response.headers.get('x-confidential-router-generation-id') as string;
    const row = await generations().findOneByOrFail({ id });
    expect(row.status).toBe('error');
  });

  it('stops paying for a generation the client walked away from', async () => {
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bearer(secret) },
      body: JSON.stringify({ ...CHAT, model: 'mock/stream-slow:tdx', stream: true }),
      signal: controller.signal,
    });
    const id = response.headers.get('x-confidential-router-generation-id') as string;

    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    controller.abort();

    const row = await eventually(() => generations().findOneBy({ id }));
    expect(row?.status).toBe('aborted');
    // Whatever arrived before the hang-up is still metered, never more.
    expect(row?.completionTokens ?? 0).toBeLessThan(7);
  });
});

/** Metering completes after the response is gone; give it a moment to land. */
async function eventually<T>(read: () => Promise<T | null>): Promise<T | null> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const value = await read();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}
