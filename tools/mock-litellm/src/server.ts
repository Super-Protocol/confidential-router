/**
 * A minimal OpenAI-compatible server standing in for LiteLLM.
 *
 * The router forwards every `/v1` request to `backends.litellm.baseUrl`
 * (ADR-002 §9). Nothing in the repository's own tests, demos or CI has a real
 * LiteLLM to forward to, so this is what sits there instead: the smallest
 * surface the router actually calls, answered the way LiteLLM answers it —
 * streamed deltas as `text/event-stream`, a usage-only chunk when
 * `stream_options.include_usage` asks for one, and a usage block on every
 * non-streamed response so the router's meter is exact rather than estimated.
 *
 * It is a *stand-in*, not a simulator: the text it returns is canned, and the
 * token counts are four-characters-per-token arithmetic. What has to be right
 * is the wire shape, because that is the contract the router is written
 * against.
 *
 * Deliberately dependency-free and written in erasable-only TypeScript: the
 * compose demo image runs these sources directly under Node's type stripping,
 * from a bare `node:alpine` layer with nothing installed.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Gap between streamed chunks. Slow enough that a console shows a real tokens/s. */
export const DEFAULT_CHUNK_GAP_MS = 5;

/** How the mock counts tokens. Not a tokenizer — see the module comment. */
const CHARS_PER_TOKEN = 4;

export interface MockLiteLLMOptions {
  /** 0 (the default) binds an ephemeral port — read it back from `url`. */
  port?: number;
  host?: string;
  /** Milliseconds between streamed chunks. */
  chunkGapMs?: number;
  /**
   * Models this backend refuses, and how. The key is the `model` the router
   * forwards; a request naming one gets that status and body instead of a
   * completion, which is how a test drives the router's upstream-error table
   * without a second server.
   */
  failures?: Record<string, UpstreamFailure>;
}

export interface UpstreamFailure {
  status: number;
  /** Defaults to an OpenAI-shaped error body carrying `message`. */
  body?: unknown;
  message?: string;
}

export interface MockLiteLLM {
  readonly url: string;
  readonly port: number;
  /** Every request the router forwarded, in order. */
  readonly requests: RecordedRequest[];
  close(): Promise<void>;
}

export interface RecordedRequest {
  method: string;
  path: string;
  authorization: string | undefined;
  body: Record<string, unknown>;
}

interface ChatMessage {
  role?: string;
  content?: unknown;
}

interface CompletionRequest {
  model?: unknown;
  prompt?: unknown;
  messages?: unknown;
  input?: unknown;
  stream?: unknown;
  stream_options?: { include_usage?: unknown };
}

const REPLY_SENTENCES = [
  'This answer came from a mock model, not from a TEE.',
  'The router in front of it is real: it authenticated your key, priced the request and metered it.',
  'Swap `backends.litellm.baseUrl` for a real LiteLLM and nothing else about the flow changes.',
];

const tokensOf = (text: string): number => Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));

/** The last user turn, across both the string and the content-parts form. */
function promptTextOf(body: CompletionRequest): string {
  if (typeof body.prompt === 'string') {
    return body.prompt;
  }
  if (!Array.isArray(body.messages)) {
    return '';
  }
  const messages = body.messages as ChatMessage[];
  const last = [...messages].reverse().find((message) => message?.role === 'user');
  const content = last?.content;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof (part as { text?: unknown })?.text === 'string' ? (part as { text: string }).text : ''))
      .join(' ')
      .trim();
  }
  return '';
}

function replyFor(body: CompletionRequest): string {
  const prompt = promptTextOf(body);
  const opening = prompt ? `You said: ${prompt.slice(0, 200)}` : 'Hello.';
  return [opening, ...REPLY_SENTENCES].join(' ');
}

function usageFor(body: CompletionRequest, completion: string) {
  const promptTokens = tokensOf(JSON.stringify(body.messages ?? body.prompt ?? ''));
  const completionTokens = tokensOf(completion);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function chatCompletion(model: string, body: CompletionRequest) {
  const content = replyFor(body);
  return {
    id: `chatcmpl-mock-${Date.now().toString(36)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: usageFor(body, content),
  };
}

function textCompletion(model: string, body: CompletionRequest) {
  const text = replyFor(body);
  return {
    id: `cmpl-mock-${Date.now().toString(36)}`,
    object: 'text_completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, text, finish_reason: 'stop', logprobs: null }],
    usage: usageFor(body, text),
  };
}

/**
 * Streams a completion as server-sent events.
 *
 * The router always forwards `stream_options.include_usage: true` so its meter
 * is exact, and strips the extra chunk again if the client did not ask for it.
 * Honouring the flag is therefore not optional here.
 */
function stream(
  request: { model: string; body: CompletionRequest; chunkGapMs: number },
  response: ServerResponse,
): void {
  const { model, body, chunkGapMs } = request;
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  const id = `chatcmpl-mock-${Date.now().toString(36)}`;
  const created = Math.floor(Date.now() / 1000);
  const content = replyFor(body);
  const chunk = (choices: unknown[], extra: Record<string, unknown> = {}): string =>
    `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices, ...extra })}\n\n`;

  // Word by word, keeping the leading space so concatenating the deltas
  // reproduces the text exactly.
  const words = content.match(/\s*\S+/g) ?? [content];
  const events = [
    chunk([{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]),
    ...words.map((word) => chunk([{ index: 0, delta: { content: word }, finish_reason: null }])),
    chunk([{ index: 0, delta: {}, finish_reason: 'stop' }]),
  ];
  if (body.stream_options?.include_usage) {
    // A usage-only chunk: `choices` present and empty, as OpenAI defines it.
    events.push(chunk([], { usage: usageFor(body, content) }));
  }
  events.push('data: [DONE]\n\n');

  let index = 0;
  const pump = (): void => {
    if (response.writableEnded || response.destroyed) {
      return;
    }
    if (index >= events.length) {
      response.end();
      return;
    }
    response.write(events[index]);
    index += 1;
    setTimeout(pump, chunkGapMs);
  };
  pump();
}

function embeddings(model: string, body: CompletionRequest) {
  const inputs = Array.isArray(body.input) ? body.input : [body.input ?? ''];
  return {
    object: 'list',
    model,
    data: inputs.map((_, index) => ({
      object: 'embedding',
      index,
      // Deterministic and short; nothing ever compares these to anything.
      embedding: Array.from({ length: 8 }, (_, position) => Number(((index + position) / 16).toFixed(4))),
    })),
    usage: usageFor(body, ''),
  };
}

function failureBody(failure: UpstreamFailure, model: string): unknown {
  if (failure.body !== undefined) {
    return failure.body;
  }
  return {
    error: {
      message: failure.message ?? `mock-litellm was configured to fail ${model}`,
      type: 'upstream_error',
    },
  };
}

/**
 * Starts the server and resolves once it is accepting connections.
 *
 * The returned handle carries the bound URL, so a caller that passed port 0 —
 * every test does — never has to guess one.
 */
export function startMockLiteLLM(options: MockLiteLLMOptions = {}): Promise<MockLiteLLM> {
  const chunkGapMs = options.chunkGapMs ?? DEFAULT_CHUNK_GAP_MS;
  const failures = options.failures ?? {};
  const host = options.host ?? '127.0.0.1';
  const requests: RecordedRequest[] = [];

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = (request.url ?? '/').split('?')[0];

    if (request.method === 'GET') {
      if (path === '/health' || path === '/health/liveliness') {
        json(response, 200, { status: 'ok' });
        return;
      }
      // The router serves /v1/models from its own catalogue and never asks
      // here, but a curl against the backend should not 404.
      if (path === '/v1/models' || path === '/models') {
        json(response, 200, { object: 'list', data: [] });
        return;
      }
      json(response, 404, { error: { message: `mock-litellm does not serve ${path}` } });
      return;
    }

    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: CompletionRequest;
      try {
        body = raw ? (JSON.parse(raw) as CompletionRequest) : {};
      } catch {
        json(response, 400, { error: { message: 'body is not JSON', type: 'invalid_request_error' } });
        return;
      }

      const model = String(body.model ?? 'mock/chat');
      requests.push({
        method: request.method ?? 'POST',
        path,
        authorization: request.headers.authorization,
        body: body as Record<string, unknown>,
      });

      const failure = failures[model];
      if (failure) {
        json(response, failure.status, failureBody(failure, model));
        return;
      }

      if (path.endsWith('/chat/completions')) {
        if (body.stream === true) {
          stream({ model, body, chunkGapMs }, response);
          return;
        }
        json(response, 200, chatCompletion(model, body));
        return;
      }
      if (path.endsWith('/completions')) {
        json(response, 200, textCompletion(model, body));
        return;
      }
      if (path.endsWith('/embeddings')) {
        json(response, 200, embeddings(model, body));
        return;
      }
      json(response, 404, {
        error: { message: `mock-litellm does not serve ${path}`, type: 'invalid_request_error' },
      });
    });
  });

  return new Promise<MockLiteLLM>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => {
      server.removeListener('error', reject);
      resolve(handleFor(server, host, requests));
    });
  });
}

function handleFor(server: Server, host: string, requests: RecordedRequest[]): MockLiteLLM {
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${host}:${port}`,
    port,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
