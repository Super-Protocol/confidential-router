import { afterEach, describe, expect, it } from 'vitest';
import { type MockLiteLLM, startMockLiteLLM } from './server.js';

let backend: MockLiteLLM | undefined;

async function start(options: Parameters<typeof startMockLiteLLM>[0] = {}): Promise<MockLiteLLM> {
  backend = await startMockLiteLLM({ chunkGapMs: 0, ...options });
  return backend;
}

afterEach(async () => {
  await backend?.close();
  backend = undefined;
});

/** Collects the `data:` payloads of an SSE body, `[DONE]` excluded. */
async function readEvents(response: Response): Promise<Record<string, unknown>[]> {
  const text = await response.text();
  return text
    .split('\n\n')
    .map((block) => block.replace(/^data: /, '').trim())
    .filter((payload) => payload.length > 0 && payload !== '[DONE]')
    .map((payload) => JSON.parse(payload) as Record<string, unknown>);
}

describe('mock-litellm', () => {
  it('answers a chat completion with the usage block the router meters on', async () => {
    const { url } = await start();

    const response = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'vllm/llama-3.3-70b', messages: [{ role: 'user', content: 'Ping' }] }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      model: string;
      choices: { message: { content: string } }[];
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };
    expect(body.model).toBe('vllm/llama-3.3-70b');
    expect(body.choices[0].message.content).toContain('You said: Ping');
    expect(body.usage.total_tokens).toBe(body.usage.prompt_tokens + body.usage.completion_tokens);
    expect(body.usage.completion_tokens).toBeGreaterThan(0);
  });

  it('reads the last user turn out of the content-parts form', async () => {
    const { url } = await start();

    const response = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'vllm/llama-3.3-70b',
        messages: [
          { role: 'system', content: 'ignored' },
          { role: 'user', content: [{ type: 'text', text: 'parts form' }] },
        ],
      }),
    });

    const body = (await response.json()) as { choices: { message: { content: string } }[] };
    expect(body.choices[0].message.content).toContain('You said: parts form');
  });

  it('streams deltas that concatenate back to the completion', async () => {
    const { url } = await start();

    const response = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'vllm/llama-3.3-70b',
        messages: [{ role: 'user', content: 'Ping' }],
        stream: true,
      }),
    });

    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const events = await readEvents(response);
    const text = events
      .flatMap((event) => (event.choices as { delta?: { content?: string } }[]) ?? [])
      .map((choice) => choice.delta?.content ?? '')
      .join('');
    expect(text).toContain('You said: Ping');
    const last = events.at(-1)?.choices as { finish_reason?: string }[];
    expect(last[0].finish_reason).toBe('stop');
  });

  it('emits a usage-only chunk when stream_options asks for one, and not otherwise', async () => {
    const { url } = await start();
    const call = (streamOptions: Record<string, unknown> | undefined) =>
      fetch(`${url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'vllm/llama-3.3-70b',
          messages: [{ role: 'user', content: 'Ping' }],
          stream: true,
          ...(streamOptions ? { stream_options: streamOptions } : {}),
        }),
      });

    const withUsage = await readEvents(await call({ include_usage: true }));
    const usageChunk = withUsage.at(-1) as { usage?: { total_tokens: number }; choices: unknown[] };
    expect(usageChunk.choices).toEqual([]);
    expect(usageChunk.usage?.total_tokens).toBeGreaterThan(0);

    const withoutUsage = await readEvents(await call(undefined));
    expect(withoutUsage.every((event) => event.usage === undefined)).toBe(true);
  });

  it('fails exactly the models it was told to fail', async () => {
    const { url } = await start({
      failures: { 'vllm/broken': { status: 429, message: 'slow down' } },
    });

    const rejected = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'vllm/broken', messages: [{ role: 'user', content: 'Ping' }] }),
    });
    expect(rejected.status).toBe(429);
    expect(((await rejected.json()) as { error: { message: string } }).error.message).toBe('slow down');

    const accepted = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'vllm/fine', messages: [{ role: 'user', content: 'Ping' }] }),
    });
    expect(accepted.status).toBe(200);
  });

  it('records what the router forwarded, credential included', async () => {
    const backendHandle = await start();

    await fetch(`${backendHandle.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer upstream-token' },
      body: JSON.stringify({ model: 'vllm/llama-3.3-70b', messages: [{ role: 'user', content: 'Ping' }] }),
    });

    expect(backendHandle.requests).toHaveLength(1);
    expect(backendHandle.requests[0].path).toBe('/v1/chat/completions');
    expect(backendHandle.requests[0].authorization).toBe('Bearer upstream-token');
    expect(backendHandle.requests[0].body.model).toBe('vllm/llama-3.3-70b');
  });

  it('answers the health and models probes, and 404s anything else', async () => {
    const { url } = await start();

    expect((await fetch(`${url}/health`)).status).toBe(200);
    expect((await fetch(`${url}/v1/models`)).status).toBe(200);
    expect((await fetch(`${url}/nope`)).status).toBe(404);
  });

  it('rejects a body that is not JSON rather than answering with fiction', async () => {
    const { url } = await start();

    const response = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });

    expect(response.status).toBe(400);
  });

  it('serves text completions and embeddings', async () => {
    const { url } = await start();

    const completion = await fetch(`${url}/v1/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'vllm/llama-3.3-70b', prompt: 'Ping' }),
    });
    expect(((await completion.json()) as { object: string }).object).toBe('text_completion');

    const embedding = await fetch(`${url}/v1/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'vllm/embed', input: ['a', 'b'] }),
    });
    expect(((await embedding.json()) as { data: unknown[] }).data).toHaveLength(2);
  });
});
