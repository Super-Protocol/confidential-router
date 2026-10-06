import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { postToUpstream, UpstreamUnavailableError } from './upstream-fetch.js';

/**
 * The retry rule both legs share, and the one property that makes it safe: a
 * request is only ever sent twice when the first attempt never established a
 * connection. Extracted for the external egress leg (ADR-008 §4), so it is worth
 * one spec rather than two copies of a comment.
 */

let server: Server | null = null;

async function serving(handler: Parameters<typeof createServer>[1]): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
  }
});

/**
 * A loopback URL nothing is listening on — bound and released, so the port is
 * real and free rather than one `fetch` refuses to dial at all (the WHATWG
 * blocked-port list makes `:1` fail with "bad port" before a connection is even
 * attempted, which is not the failure this spec is about).
 */
async function closedPortUrl(): Promise<string> {
  const url = await serving((request, response) => {
    request.resume();
    response.end();
  });
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = null;
  return url;
}

function call(url: string, overrides: Partial<Parameters<typeof postToUpstream>[0]> = {}) {
  return postToUpstream({
    url,
    headers: { 'content-type': 'application/json' },
    body: { model: 'x' },
    connectTimeoutMs: 2_000,
    signal: AbortSignal.timeout(5_000),
    ...overrides,
  });
}

describe('postToUpstream', () => {
  it('sends the body once and returns whatever the upstream answered', async () => {
    let calls = 0;
    const url = await serving((request, response) => {
      calls += 1;
      request.resume();
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });

    const response = await call(url);

    expect(response.status).toBe(201);
    expect(calls).toBe(1);
  });

  it('does not retry an upstream that answered badly — the generation may have run', async () => {
    let calls = 0;
    const url = await serving((request, response) => {
      calls += 1;
      request.resume();
      response.writeHead(500);
      response.end('{}');
    });

    const response = await call(url);

    expect(response.status).toBe(500);
    expect(calls).toBe(1);
  });

  it('retries once when nothing was ever sent', async () => {
    const retries: number[] = [];
    // A refused connection is the pre-send failure the rule is for: the upstream
    // has not seen the request, so sending it again cannot run a generation twice.
    const url = await closedPortUrl();

    await expect(call(url, { onRetry: (attempt) => retries.push(attempt) })).rejects.toBeInstanceOf(
      UpstreamUnavailableError,
    );

    expect(retries).toEqual([1]);
  });

  it('stops immediately when the caller’s own signal aborted', async () => {
    const retries: number[] = [];
    const url = await closedPortUrl();
    const abort = new AbortController();
    abort.abort(new Error('the client left'));

    await expect(call(url, { signal: abort.signal, onRetry: (a) => retries.push(a) })).rejects.toThrow();

    // No `UpstreamUnavailableError` wrapper and no retry: there is nobody left to
    // answer, so a second attempt would only cost the upstream a generation.
    expect(retries).toEqual([]);
  });

  it('abandons a connection that is never accepted, inside the connect deadline', async () => {
    const url = await serving((request) => {
      // Accepted at the TCP level and then ignored for ever, which is the hang the
      // deadline exists for.
      request.resume();
    });

    await expect(call(url, { connectTimeoutMs: 40 })).rejects.toBeInstanceOf(UpstreamUnavailableError);
  });
});
