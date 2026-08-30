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

export const STREAM_USAGE = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 };

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
        this.respond(String(body.model ?? ''), body, response);
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

  private respond(model: string, body: Record<string, unknown>, response: ServerResponse): void {
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

  private stream(body: Record<string, unknown>, response: ServerResponse): void {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    const events = STREAM_CHUNKS.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`);
    const includeUsage = Boolean((body.stream_options as { include_usage?: unknown } | undefined)?.include_usage);
    if (includeUsage && body.model !== 'mock/no-usage') {
      events.push(
        `data: ${JSON.stringify({
          id: 'chatcmpl-upstream',
          object: 'chat.completion.chunk',
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
    const gapMs = model === 'mock/stream-slow' ? 60 : 0;
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
      if (gapMs > 0) {
        setTimeout(pump, gapMs);
      } else {
        setImmediate(pump);
      }
    };
    pump();
  }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}
