import type { Response as ExpressResponse } from 'express';
import { describe, expect, it } from 'vitest';
import type { ApiKeyRequest } from './api-key.guard.js';
import type { ExternalUpstreamClient } from './external-upstream.client.js';
import { GatewayService } from './gateway.service.js';
import type { GatewayContext, GenerationOutcome, RoutedModel } from './gateway.types.js';
import type { GatewayAnalytics } from './gateway-analytics.service.js';
import type { GatewayPolicyService } from './gateway-policy.service.js';
import type { GenerationRecorder } from './generation-recorder.service.js';
import type { LiteLlmClient } from './litellm.client.js';

/**
 * The window between the upstream's headers arriving and the relay taking over.
 *
 * It is one tick wide, which is exactly why it cannot be driven from the e2e
 * suite: the client has to hang up *after* `fetch` resolved and *before* the
 * relay installs its own `close` listener. Here the fake upstream closes the
 * response itself, one statement before it answers, so the race lands the same
 * way every run.
 *
 * What is at stake is a metering row. Before SUP-449 a hang-up in this window
 * was read off the torn-down body as `error` / `backend_unavailable`, reporting
 * a failure on a request where nothing failed and nobody was waiting.
 */

const MODEL = {
  id: 'mock/chat:tdx',
  name: 'mock/chat:tdx',
  upstreamModel: 'mock/chat',
  contextLength: 4096,
  capabilities: ['chat'],
  promptPer1mMicros: 1_000_000,
  completionPer1mMicros: 1_000_000,
  origin: 'config',
  endpoint: { id: 'ep-1', name: 'mock-primary', hostname: 'primary.mock.tee.example' },
  external: null,
  updatedAt: new Date(),
} as unknown as RoutedModel;

/** Just enough of an Express response to hang up on command. */
class HangingUpResponse {
  writableEnded = false;
  headersSent = false;
  destroyed = false;
  readonly written: string[] = [];
  private readonly listeners = new Map<string, Set<() => void>>();

  status(): this {
    return this;
  }
  setHeader(): this {
    return this;
  }
  type(): this {
    return this;
  }
  send(): this {
    return this;
  }
  flushHeaders(): void {
    this.headersSent = true;
  }
  write(chunk: string): boolean {
    this.written.push(chunk);
    return true;
  }
  end(): void {
    this.writableEnded = true;
  }
  on(event: string, listener: () => void): this {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
    return this;
  }
  off(event: string, listener: () => void): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  /** What Express does when the client walks away. */
  hangUp(): void {
    this.destroyed = true;
    for (const listener of this.listeners.get('close') ?? []) {
      listener();
    }
  }

  as(): ExpressResponse {
    return this as unknown as ExpressResponse;
  }
}

function request(stream: boolean): ApiKeyRequest {
  return {
    apiKey: { workspace: { id: 'ws-1' }, key: { id: 'key-1' } },
    body: { model: MODEL.id, stream, messages: [{ role: 'user', content: 'Hello there' }] },
    headers: {},
    ip: '127.0.0.1',
  } as unknown as ApiKeyRequest;
}

/** Builds the service with fakes, and hands back what the recorder was told. */
function gateway(send: (response: HangingUpResponse) => Promise<Response>) {
  const recorded: GenerationOutcome[] = [];
  let httpResponse!: HangingUpResponse;

  const policy = {
    resolve: () => MODEL,
    admit: async () => ({}),
    settle: async () => undefined,
  } as unknown as GatewayPolicyService;
  const recorder = {
    begin: async () => ({ id: 'gen-01J6TEST', coverage: null, evidenceDigest: null }),
    finish: async (_context: GatewayContext, outcome: GenerationOutcome) => {
      recorded.push(outcome);
    },
  } as unknown as GenerationRecorder;
  const upstream = {
    readTimeoutMs: 5_000,
    send: async () => send(httpResponse),
  } as unknown as LiteLlmClient;

  const service = new GatewayService(
    { server: { streamKeepAliveAfter: 15_000 } } as never,
    policy,
    recorder,
    upstream,
    {} as unknown as ExternalUpstreamClient,
    { modelRequested: async () => undefined } as unknown as GatewayAnalytics,
  );

  return {
    recorded,
    async handle(stream: boolean): Promise<HangingUpResponse> {
      httpResponse = new HangingUpResponse();
      await service.handle(request(stream), httpResponse.as(), 'chat');
      return httpResponse;
    },
  };
}

const EVENT_STREAM = { status: 200, headers: { 'content-type': 'text/event-stream' } };

describe('a client that hangs up as the upstream answers', () => {
  it('is metered aborted, not as a failure of a backend that answered fine', async () => {
    const harness = gateway(async (response) => {
      // The hang-up and the 200 cross: the abort arrives after `fetch` already
      // had its headers, so nothing throws and the success path runs.
      response.hangUp();
      return new Response('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n', EVENT_STREAM);
    });

    await harness.handle(true);

    expect(harness.recorded).toHaveLength(1);
    expect(harness.recorded[0]).toMatchObject({ status: 'aborted', errorCode: null, completionTokens: 0 });
  });

  it('still meters a non-streamed completion as the generation it was', async () => {
    // The close-watch is a streaming affair: a non-streamed request's tokens
    // were produced whether or not anyone is left to read them.
    const harness = gateway(async (response) => {
      response.hangUp();
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-upstream',
          choices: [{ index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    await harness.handle(false);

    expect(harness.recorded).toHaveLength(1);
    expect(harness.recorded[0]).toMatchObject({ status: 'ok', errorCode: null, completionTokens: 7 });
  });
});
