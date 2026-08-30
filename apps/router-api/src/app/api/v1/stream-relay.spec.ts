import type { Response as ExpressResponse } from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import type { GatewayContext } from './gateway.types.js';
import { relayStream } from './stream-relay.js';

/**
 * The two behaviours the e2e suites cannot reach: the heartbeat that keeps a
 * slow first token from looking like a dead connection, and the read deadline
 * that gives up on a backend which stopped talking. Both are measured in tens of
 * seconds in production, so they are driven here against a hand-fed stream.
 */

const context = {
  generationId: 'gen-01J6TEST',
  model: {
    id: 'mock/chat:tdx',
    promptPer1mMicros: 1_000_000,
    completionPer1mMicros: 1_000_000,
    endpoint: { name: 'mock-primary', hostname: 'primary.mock.tee.example' },
  },
  body: { messages: [{ role: 'user', content: 'Hello there' }] },
  stream: true,
  suppressUsageChunk: false,
  coverage: null,
  startedAt: Date.now(),
} as unknown as GatewayContext;

/** Just enough of an Express response to record what the relay wrote. */
class RecordingResponse {
  readonly written: string[] = [];
  writableEnded = false;
  private readonly listeners = new Map<string, () => void>();

  status(): this {
    return this;
  }
  setHeader(): this {
    return this;
  }
  flushHeaders(): void {}
  write(chunk: string): boolean {
    this.written.push(chunk);
    return true;
  }
  end(): void {
    this.writableEnded = true;
  }
  on(event: string, listener: () => void): this {
    this.listeners.set(event, listener);
    return this;
  }
  off(event: string): this {
    this.listeners.delete(event);
    return this;
  }

  as(): ExpressResponse {
    return this as unknown as ExpressResponse;
  }
}

/**
 * An upstream whose chunks arrive when the test says so. Aborting the
 * controller errors the body, which is what `fetch` does to a cancelled
 * response.
 */
function upstream(abort: AbortController) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(source) {
      controller = source;
    },
  });
  abort.signal.addEventListener('abort', () => {
    try {
      controller.error(abort.signal.reason);
    } catch {
      // Already closed; nothing to cancel.
    }
  });
  return {
    response: new Response(body, { headers: { 'content-type': 'text/event-stream' } }) as Response,
    push: (event: string) => controller.enqueue(encoder.encode(event)),
    close: () => controller.close(),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const CONTENT = `data: ${JSON.stringify({
  id: 'chatcmpl-upstream',
  model: 'mock/chat',
  choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: 'stop' }],
})}\n\n`;

let pending: Promise<unknown> | undefined;

afterEach(async () => {
  await pending;
  pending = undefined;
});

describe('heartbeat', () => {
  it('keeps the connection alive while the first token is still coming, and stops once it has', async () => {
    const abort = new AbortController();
    const source = upstream(abort);
    const response = new RecordingResponse();

    const relay = relayStream({
      context: { ...context, startedAt: Date.now() },
      upstream: source.response,
      response: response.as(),
      readTimeoutMs: 5_000,
      abort,
      heartbeatIntervalMs: 10,
    });
    pending = relay;

    await sleep(45);
    const beforeFirstToken = response.written.filter((event) => event === ': ping\n\n').length;
    expect(beforeFirstToken).toBeGreaterThanOrEqual(2);

    source.push(CONTENT);
    await sleep(45);
    const afterFirstToken = response.written.filter((event) => event === ': ping\n\n').length;
    expect(afterFirstToken).toBe(beforeFirstToken);

    source.close();
    const outcome = await relay;
    expect(outcome.status).toBe('ok');
    expect(response.written.at(-1)).toBe('data: [DONE]\n\n');
  });
});

describe('read deadline', () => {
  it('gives up on a backend that stopped sending, and closes the stream properly', async () => {
    const abort = new AbortController();
    const source = upstream(abort);
    const response = new RecordingResponse();

    const relay = relayStream({
      context: { ...context, startedAt: Date.now() },
      upstream: source.response,
      response: response.as(),
      readTimeoutMs: 30,
      abort,
      heartbeatIntervalMs: 10_000,
    });
    pending = relay;

    source.push(CONTENT);
    const outcome = await relay;

    expect(outcome.status).toBe('error');
    // The status line left long ago, so the failure travels as a data event —
    // followed by the terminator the client is waiting for.
    const errorEvent = response.written.at(-2) as string;
    expect(JSON.parse(errorEvent.replace('data: ', '')).error).toMatchObject({ type: 'server_error' });
    expect(response.written.at(-1)).toBe('data: [DONE]\n\n');
    expect(response.writableEnded).toBe(true);
    // Whatever arrived before the deadline is still counted.
    expect(outcome.completionTokens).toBeGreaterThan(0);
  });
});
