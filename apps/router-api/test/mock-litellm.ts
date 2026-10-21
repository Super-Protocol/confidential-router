import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A LiteLLM-compatible backend for the e2e suite.
 *
 * Behaviour is selected by the `model` the router forwards — which is the
 * `litellmModel` from the test's router config, never the public model id — so
 * one server covers the whole error table without any out-of-band setup.
 *
 * `docker/mock-litellm` is the same idea for the compose stack; this one runs
 * in-process so a test can assert on exactly what the router sent upstream.
 */

export interface RecordedRequest {
  path: string;
  body: Record<string, unknown>;
  authorization?: string;
  metadata?: string;
  accept?: string;
}

/** The chunks `mock/chat` streams. Exported so a test can assert byte fidelity. */
export const STREAM_CHUNKS: Record<string, unknown>[] = [
  {
    id: 'chatcmpl-upstream',
    object: 'chat.completion.chunk',
    created: 1_756_550_000,
    model: 'mock/chat',
    choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
  },
  {
    id: 'chatcmpl-upstream',
    object: 'chat.completion.chunk',
    created: 1_756_550_000,
    model: 'mock/chat',
    choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }],
  },
  {
    id: 'chatcmpl-upstream',
    object: 'chat.completion.chunk',
    created: 1_756_550_000,
    model: 'mock/chat',
    // Unicode and an embedded newline: both have to survive the relay intact.
    choices: [{ index: 0, delta: { content: ' wörld ✨\nsecond line' }, finish_reason: null }],
  },
  {
    id: 'chatcmpl-upstream',
    object: 'chat.completion.chunk',
    created: 1_756_550_000,
    model: 'mock/chat',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  },
];

/**
 * What `mock/stream-tools` streams: an agent's turn, which is the common shape
 * in production and the one that used to record no time to first token at all.
 * Not one `content` delta anywhere — the arguments arrive in `tool_calls`.
 */
export const TOOL_CALL_STREAM_CHUNKS: Record<string, unknown>[] = [
  {
    id: 'chatcmpl-upstream',
    object: 'chat.completion.chunk',
    created: 1_756_550_000,
    model: 'mock/stream-tools',
    choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
  },
  {
    id: 'chatcmpl-upstream',
    object: 'chat.completion.chunk',
    created: 1_756_550_000,
    model: 'mock/stream-tools',
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read', arguments: '' } }],
        },
        finish_reason: null,
      },
    ],
  },
  {
    id: 'chatcmpl-upstream',
    object: 'chat.completion.chunk',
    created: 1_756_550_000,
    model: 'mock/stream-tools',
    choices: [
      {
        index: 0,
        delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"README.md"}' } }] },
        finish_reason: null,
      },
    ],
  },
  {
    id: 'chatcmpl-upstream',
    object: 'chat.completion.chunk',
    created: 1_756_550_000,
    model: 'mock/stream-tools',
    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
  },
];

export const STREAM_USAGE = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 };

/**
 * Gap between the chunks of a normal stream.
 *
 * Deliberately not zero. With `setImmediate` alone a fast runner delivers every
 * chunk inside the same millisecond, so the router measures a generation that
 * took no time at all, `tokensPerSecond` is `null` for want of a denominator,
 * and the e2e assertion on the recorded rate fails for reasons that have
 * nothing to do with the router.
 *
 * Wide enough, now, that the generation window clears the floor the rate is
 * reported above (`MIN_RATE_WINDOW_MS` in `pricing.ts`): a sample of a couple of
 * milliseconds is one the router deliberately refuses to divide (SUP-424). Three
 * gaps after the first token, so ~36 ms, and still some 40 ms per streaming test.
 */
const CHUNK_GAP_MS = 12;

/**
 * What the backend answers on its own `/v1/completions`, for a model whose
 * router entry declares `completions`. A `text_completion`, not a chat one: the
 * router forwards that request verbatim and must pass the answer back the same
 * way — the translation path is for models that declare chat alone (SUP-450).
 */
export const TEXT_COMPLETION_BODY = {
  id: 'cmpl-upstream',
  object: 'text_completion',
  created: 1_756_550_000,
  model: 'mock/chat',
  choices: [{ index: 0, text: 'native legacy text', logprobs: null, finish_reason: 'stop' }],
  usage: STREAM_USAGE,
};

/** The chunks the backend streams on its own `/v1/completions`. */
export const TEXT_COMPLETION_STREAM_CHUNKS: Record<string, unknown>[] = [
  {
    id: 'cmpl-upstream',
    object: 'text_completion',
    created: 1_756_550_000,
    model: 'mock/chat',
    choices: [{ index: 0, text: 'native', logprobs: null, finish_reason: null }],
  },
  {
    id: 'cmpl-upstream',
    object: 'text_completion',
    created: 1_756_550_000,
    model: 'mock/chat',
    choices: [{ index: 0, text: ' legacy', logprobs: null, finish_reason: 'stop' }],
  },
];

export const COMPLETION_BODY = {
  id: 'chatcmpl-upstream',
  object: 'chat.completion',
  created: 1_756_550_000,
  model: 'mock/chat',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Hello world' }, finish_reason: 'stop' }],
  usage: STREAM_USAGE,
};

export class MockLiteLlm {
  readonly requests: RecordedRequest[] = [];
  private server?: Server;

  async start(): Promise<string> {
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
        this.requests.push({
          path: request.url ?? '',
          body,
          authorization: request.headers.authorization,
          metadata: request.headers['x-litellm-metadata'] as string | undefined,
          accept: request.headers.accept,
        });
        this.respond(body, response, request.url ?? '');
      });
    });
    this.server = server;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) {
      return;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.server = undefined;
  }

  reset(): void {
    this.requests.length = 0;
  }

  private respond(body: Record<string, unknown>, response: ServerResponse, path: string): void {
    const model = String(body.model ?? '');
    switch (model) {
      case 'mock/boom':
        json(response, 500, { error: { message: 'The worker crashed.', type: 'server_error' } });
        return;
      case 'mock/overloaded':
        response.setHeader('retry-after', '7');
        json(response, 429, { error: { message: 'All workers are busy.' } });
        return;
      case 'mock/context':
        json(response, 400, {
          error: { message: "This model's maximum context length is 4096 tokens, however you requested 9000." },
        });
        return;
      case 'mock/refuses':
        json(response, 401, { error: { message: 'Invalid LiteLLM key.' } });
        return;
      case 'mock/garbage':
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('<html>not json</html>');
        return;
      case 'mock/hangup':
        // Killed before a byte of the response: a connection error, which is
        // the only failure the client is allowed to retry.
        response.socket?.destroy();
        return;
      case 'mock/thinking':
        // Took the request and never answered — a long prefill or a queued burst
        // as the router sees it. The connection is up and the upstream is fine,
        // so whatever the router says about this must not be "unreachable"
        // (SUP-339). Left to the harness's own teardown to close.
        return;
      case 'mock/embed':
        json(response, 200, {
          object: 'list',
          data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] }],
          model: 'mock/embed',
          usage: { prompt_tokens: 5, total_tokens: 5 },
        });
        return;
      default:
        break;
    }

    // The legacy route, served by the backend itself: the router only forwards
    // here, so the shape has to be the legacy one both ways.
    if (path === '/v1/completions') {
      if (body.stream === true) {
        this.stream(body, response, TEXT_COMPLETION_STREAM_CHUNKS);
        return;
      }
      json(response, 200, TEXT_COMPLETION_BODY);
      return;
    }
    if (body.stream === true) {
      this.stream(body, response);
      return;
    }
    if (model === 'mock/no-usage') {
      const { usage: _usage, ...withoutUsage } = COMPLETION_BODY;
      json(response, 200, withoutUsage);
      return;
    }
    json(response, 200, COMPLETION_BODY);
  }

  private stream(body: Record<string, unknown>, response: ServerResponse, override?: Record<string, unknown>[]): void {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    const chunks = override ?? (body.model === 'mock/stream-tools' ? TOOL_CALL_STREAM_CHUNKS : STREAM_CHUNKS);
    const events = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`);
    const includeUsage = Boolean((body.stream_options as { include_usage?: unknown } | undefined)?.include_usage);
    if (includeUsage && body.model !== 'mock/no-usage') {
      events.push(
        `data: ${JSON.stringify({
          id: 'chatcmpl-upstream',
          object: override ? 'text_completion' : 'chat.completion.chunk',
          created: 1_756_550_000,
          model: 'mock/chat',
          choices: [],
          usage: STREAM_USAGE,
        })}\n\n`,
      );
    }
    events.push('data: [DONE]\n\n');

    // One event per tick, and the second one split down the middle: the relay
    // has to reassemble a partial event across two reads without corrupting it.
    const model = String(body.model ?? '');
    // A backend that dies mid-stream, and one slow enough for a client to give
    // up on: the two ways a stream ends without a `[DONE]`.
    const dieAfter = model === 'mock/stream-abort' ? 2 : Number.POSITIVE_INFINITY;
    const gapMs = model === 'mock/stream-slow' ? 60 : CHUNK_GAP_MS;
    let index = 0;
    const pump = (): void => {
      if (index >= dieAfter) {
        response.socket?.destroy();
        return;
      }
      if (index >= events.length) {
        response.end();
        return;
      }
      const event = events[index];
      index += 1;
      if (index === 2) {
        const half = Math.floor(event.length / 2);
        response.write(event.slice(0, half));
        setImmediate(() => {
          response.write(event.slice(half));
          next();
        });
        return;
      }
      response.write(event);
      next();
    };
    const next = (): void => {
      setTimeout(pump, gapMs);
    };
    pump();
  }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}
