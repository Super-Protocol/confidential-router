import { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Generation } from '../src/app/db/entities/generation.entity.js';
import { createHarness, type Harness, listen } from './app-harness.js';
import { bearer, createKey, routerConfigFor, seedWorkspace } from './gateway-fixture.js';
import { MockLiteLlm } from './mock-litellm.js';

/**
 * What a streamed request looks like while the upstream is still thinking.
 *
 * SUP-449: seven of 97 agent turns driven against production waited exactly 60 s
 * and ended in a 502. Three of those were not the router's — the ingress in front
 * of it ran out of patience first and answered an openresty HTML page, so the
 * client got no error envelope, no `x-request-id`, and Logs got no row at all,
 * because the request never came back through the code that writes one.
 *
 * The router's answer is to stop being silent: past `server.streamKeepAliveAfter`
 * it opens the event stream itself and heartbeats into it, which resets every
 * proxy's read deadline on the path and keeps the request ending where the router
 * can account for it. This suite boots that deadline down to its 1 s floor,
 * and the mock upstream stalls for 1.5 s before it answers at all.
 */

const upstream = new MockLiteLlm();

let harness: Harness;
let baseUrl: string;
let secret: string;

beforeAll(async () => {
  const upstreamUrl = await upstream.start();
  harness = await createHarness({
    config: routerConfigFor(upstreamUrl, { server: { streamKeepAliveAfter: '1s' } }),
  });
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
}

async function post(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
  return fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...bearer(secret) },
    body: JSON.stringify(body),
    signal,
  });
}

async function stream(model: string): Promise<StreamResult> {
  const response = await post({ model, stream: true, messages: [{ role: 'user', content: 'Hello there' }] });
  const text = await response.text();
  const events = text
    .split('\n\n')
    .filter((event) => event.length > 0)
    .map((event) => `${event}\n\n`);
  return { response, events };
}

function generations() {
  return harness.app.get(DataSource).getRepository(Generation);
}

/** The row for a model, once the handler that writes it has got there. */
async function rowFor(modelId: string): Promise<Generation> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const row = await generations().findOne({ where: { modelId }, order: { createdAt: 'DESC' } });
    if (row) {
      return row;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`No generation row was ever written for ${modelId}.`);
}

describe('a streamed request the upstream is slow to answer', () => {
  it('opens the stream and heartbeats rather than leaving the socket silent', async () => {
    const { response, events } = await stream('mock/slow-start:tdx');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    // The heartbeat arrived before the upstream had sent anything at all.
    expect(events[0]).toBe(': ping\n\n');
    expect(events.at(-1)).toBe('data: [DONE]\n\n');
    expect(events.some((event) => event.includes('"content":"Hello"'))).toBe(true);

    const row = await rowFor('mock/slow-start:tdx');
    expect(row).toMatchObject({ status: 'ok', errorCode: null, streamed: true });
  });

  it('delivers a late failure inside the stream it already opened, and still records it', async () => {
    const { response, events } = await stream('mock/slow-boom:tdx');

    // 200, because the status line went out with the keep-alive preamble — the
    // alternative measured in production was an ingress-minted HTML page.
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(events[0]).toBe(': ping\n\n');
    expect(JSON.parse((events.at(-2) as string).replace('data: ', '')).error).toMatchObject({
      type: 'upstream_error',
      code: 'backend_unavailable',
    });
    expect(events.at(-1)).toBe('data: [DONE]\n\n');

    const row = await rowFor('mock/slow-boom:tdx');
    expect(row).toMatchObject({ status: 'error', errorCode: 'backend_unavailable', costMicros: 0 });
  });

  it('records the generation when the client gives up before the first token', async () => {
    // The ingress resetting the socket under a request the router is still
    // serving looks exactly like this from here, and it is why three of the seven
    // never reached Logs.
    const abort = new AbortController();
    const response = await post(
      { model: 'mock/thinking:tdx', stream: true, messages: [{ role: 'user', content: 'Hello' }] },
      abort.signal,
    );
    // The keep-alive has already opened the stream; the upstream never will.
    expect(response.status).toBe(200);
    setTimeout(() => abort.abort(), 100);
    await expect(response.text()).rejects.toThrow();

    const row = await rowFor('mock/thinking:tdx');
    expect(row).toMatchObject({ status: 'aborted', errorCode: null, costMicros: 0, streamed: true });
  });
});

describe('a failure fast enough to beat the keep-alive', () => {
  it('keeps its status code and its JSON envelope', async () => {
    const { response, events } = await stream('mock/boom:tdx');

    expect(response.status).toBe(502);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(JSON.parse(events.join('')).error).toMatchObject({ code: 'backend_unavailable' });
  });

  it('is never pre-empted on a non-streaming request, however slow the upstream is', async () => {
    // Nothing can be heartbeated into a JSON response, so the contract there is
    // unchanged: the status line is the only channel, and it waits.
    const response = await post({ model: 'mock/slow-boom:tdx', messages: [{ role: 'user', content: 'Hello' }] });

    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error).toMatchObject({ type: 'upstream_error', code: 'backend_unavailable' });
  });
});
