import { describe, expect, it, vi } from 'vitest';
import { dataPayloadOf, streamChatCompletion } from './chat-stream';

/** A body that yields the given chunks, so a delta can be split across two of them. */
function bodyOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function sseResponse(chunks: string[]): Response {
  return new Response(bodyOf(chunks), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function delta(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

async function collect(
  chunks: string[],
): Promise<{ text: string; outcome: Awaited<ReturnType<typeof streamChatCompletion>> }> {
  let text = '';
  const outcome = await streamChatCompletion({
    baseUrl: 'https://api.test/v1',
    apiKey: 'sk-tee-v1-x',
    model: 'vendor/model',
    messages: [{ role: 'user', content: 'hello' }],
    onDelta: (piece) => {
      text += piece;
    },
    fetcher: async () => sseResponse(chunks),
  });
  return { text, outcome };
}

describe('dataPayloadOf', () => {
  it('rejoins a multi-line payload as SSE requires', () => {
    expect(dataPayloadOf('data: {"a":\ndata: 1}')).toBe('{"a":\n1}');
  });

  it('answers null for a comment heartbeat, which carries no data', () => {
    expect(dataPayloadOf(': ping')).toBeNull();
  });
});

describe('streamChatCompletion', () => {
  it('sends the OpenAI request to /v1/chat/completions with the key as a bearer token', async () => {
    const fetcher = vi.fn(async () => sseResponse([delta('hi'), 'data: [DONE]\n\n']));

    await streamChatCompletion({
      baseUrl: 'https://api.test/v1/',
      apiKey: 'sk-tee-v1-secret',
      model: 'vendor/model',
      messages: [{ role: 'user', content: 'hello' }],
      onDelta: () => {},
      fetcher: fetcher as unknown as typeof fetch,
    });

    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.test/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-tee-v1-secret');
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'vendor/model',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
    });
  });

  it('delivers deltas in order and stops on [DONE]', async () => {
    const { text, outcome } = await collect([delta('Hel'), delta('lo'), 'data: [DONE]\n\n', delta(' ignored')]);

    expect(text).toBe('Hello');
    expect(outcome).toEqual({ status: 'done' });
  });

  it('reassembles an event split across two network chunks', async () => {
    const whole = delta('token');
    const { text } = await collect([whole.slice(0, 12), whole.slice(12), 'data: [DONE]\n\n']);

    expect(text).toBe('token');
  });

  it('passes over heartbeats and anything that is not JSON', async () => {
    const { text, outcome } = await collect([': ping\n\n', 'data: not json\n\n', delta('ok'), 'data: [DONE]\n\n']);

    expect(text).toBe('ok');
    expect(outcome.status).toBe('done');
  });

  it('treats a stream that ends without [DONE] as complete, not as an error', async () => {
    const { text, outcome } = await collect([delta('partial')]);

    expect(text).toBe('partial');
    expect(outcome.status).toBe('done');
  });

  it('reads the gateway’s refusal out of the OpenAI error envelope, code and all', async () => {
    const outcome = await streamChatCompletion({
      baseUrl: 'https://api.test/v1',
      apiKey: 'sk-tee-v1-x',
      model: 'vendor/model',
      messages: [],
      onDelta: () => {},
      fetcher: async () =>
        new Response(
          JSON.stringify({
            error: { message: 'Not enough credits to serve this request.', code: 'insufficient_credits' },
          }),
          { status: 402 },
        ),
    });

    expect(outcome).toEqual({
      status: 'error',
      message: 'Not enough credits to serve this request.',
      code: 'insufficient_credits',
    });
  });

  it('reports a refusal with an unreadable body by its status', async () => {
    const outcome = await streamChatCompletion({
      baseUrl: 'https://api.test/v1',
      apiKey: 'sk-tee-v1-x',
      model: 'vendor/model',
      messages: [],
      onDelta: () => {},
      fetcher: async () => new Response('<html>502</html>', { status: 502 }),
    });

    expect(outcome).toEqual({ status: 'error', message: 'The router answered 502.', code: null });
  });

  it('reports a user abort as aborted rather than as a failure', async () => {
    const controller = new AbortController();
    controller.abort();

    const outcome = await streamChatCompletion({
      baseUrl: 'https://api.test/v1',
      apiKey: 'sk-tee-v1-x',
      model: 'vendor/model',
      messages: [],
      onDelta: () => {},
      signal: controller.signal,
      fetcher: async () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      },
    });

    expect(outcome).toEqual({ status: 'aborted' });
  });

  it('reports an unreachable router without pretending the model said anything', async () => {
    const outcome = await streamChatCompletion({
      baseUrl: 'https://api.test/v1',
      apiKey: 'sk-tee-v1-x',
      model: 'vendor/model',
      messages: [],
      onDelta: () => {},
      fetcher: async () => {
        throw new TypeError('Failed to fetch');
      },
    });

    expect(outcome).toMatchObject({ status: 'error', code: null });
    expect((outcome as { message: string }).message).toContain('Failed to fetch');
  });
});
