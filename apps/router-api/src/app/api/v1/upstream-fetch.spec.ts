import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MIN_RETRY_BUDGET_MS,
  postToUpstream,
  type RetryCause,
  UpstreamTimeoutError,
  UpstreamUnavailableError,
} from './upstream-fetch.js';

/**
 * The retry rule both legs share, and the one property that makes it safe: when
 * this helper decides, not one byte of the upstream's body has been read, so the
 * caller has received nothing either way. Two failures qualify — a connection
 * that never established, and a `502`, which is a proxy saying the thing behind
 * it never answered (SUP-917). Extracted for the external egress leg
 * (ADR-008 §4), so it is worth one spec rather than two copies of a comment.
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

/**
 * A deadline a retry fits inside. Production arms this with
 * `connectTimeout + readTimeout` = 125 s, so the floor the budget check applies
 * is never the binding constraint there; the default below is deliberately
 * smaller than the floor, which is what the budget test relies on.
 */
const RETRY_FITS_MS = MIN_RETRY_BUDGET_MS * 3;

function call(url: string, overrides: Partial<Parameters<typeof postToUpstream>[0]> = {}) {
  return postToUpstream({
    url,
    headers: { 'content-type': 'application/json' },
    body: { model: 'x' },
    responseTimeoutMs: 2_000,
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

  it('does not retry a 500 — the model server considered the request and failed on it', async () => {
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

  it('retries a 502 and returns the answer the second attempt got', async () => {
    // The SUP-917 shape: a proxy in front of the model answers 502 because the
    // thing behind it never did, so the generation has not run and the request
    // can go again. One of the model cloud's three nodes does this; the retry
    // lands on another one.
    const retries: Array<[number, number, RetryCause]> = [];
    let calls = 0;
    const url = await serving((request, response) => {
      calls += 1;
      request.resume();
      if (calls === 1) {
        response.writeHead(502, { 'content-type': 'text/html' });
        response.end('<html><body>502 Bad Gateway</body></html>');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });

    const response = await call(url, { responseTimeoutMs: RETRY_FITS_MS, onRetry: (...args) => retries.push(args) });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);
    // Named apart from a refused connection: a 502 came from a different hop and
    // an operator told otherwise reads the wrong logs.
    expect(retries).toEqual([[1, 2, 'bad-gateway']]);
  });

  it('hands over the second 502 rather than trying a third time', async () => {
    const retries: Array<[number, number, RetryCause]> = [];
    let calls = 0;
    const url = await serving((request, response) => {
      calls += 1;
      request.resume();
      response.writeHead(502);
      response.end('<html><body>502 Bad Gateway</body></html>');
    });

    const response = await call(url, { responseTimeoutMs: RETRY_FITS_MS, onRetry: (...args) => retries.push(args) });

    expect(response.status).toBe(502);
    // The caller gets a readable body, not one this helper already cancelled.
    await expect(response.text()).resolves.toContain('502 Bad Gateway');
    expect(calls).toBe(2);
    expect(retries).toEqual([[1, 2, 'bad-gateway']]);
  });

  it('does not retry a 502 when too little of the budget is left to finish one', async () => {
    // A 502 that arrives late has already spent the caller's patience; a retry
    // could only turn it into the same 502 later.
    const retries: number[] = [];
    let calls = 0;
    const url = await serving((request, response) => {
      calls += 1;
      request.resume();
      setTimeout(() => {
        response.writeHead(502);
        response.end('{}');
      }, 60);
    });

    const response = await call(url, {
      // Comfortably longer than the upstream takes, and comfortably shorter than
      // the floor a retry needs — so the attempt itself succeeds and only the
      // budget check refuses.
      responseTimeoutMs: MIN_RETRY_BUDGET_MS - 1_000,
      onRetry: (attempt) => retries.push(attempt),
    });

    expect(response.status).toBe(502);
    expect(calls).toBe(1);
    expect(retries).toEqual([]);
  });

  it('does not retry when the caller hangs up while the upstream is deciding', async () => {
    // The order a real hang-up arrives in: the client leaves mid-attempt,
    // `gateway.service` aborts the signal, and `fetch` rejects before any answer
    // is returned. There is nobody left to hand a retry's answer to, so the
    // attempt is not repeated — and the abort is reported as itself rather than
    // wrapped as an unreachable upstream.
    //
    // The narrower race — an abort that lands after the headers but before the
    // status is read — is refused by the same `signal.aborted` guard, which is
    // checked synchronously on the returned response; it is not timed here
    // because a microtask gap cannot be scheduled from a test deterministically.
    const retries: number[] = [];
    let calls = 0;
    const abort = new AbortController();
    const url = await serving((request, response) => {
      calls += 1;
      request.resume();
      abort.abort(new Error('the client left'));
      setTimeout(() => {
        response.writeHead(502);
        response.end('{}');
      }, 50);
    });

    await expect(
      call(url, { responseTimeoutMs: RETRY_FITS_MS, signal: abort.signal, onRetry: (a) => retries.push(a) }),
    ).rejects.toThrow();

    expect(calls).toBe(1);
    expect(retries).toEqual([]);
  });

  it('retries a 502 on a streamed request too — the open stream carries no tokens yet', async () => {
    // By the time a gateway 502 arrives the router has usually opened its SSE
    // stream and is heartbeating into it (SUP-449), so the status line is gone.
    // That is exactly why the retry belongs here: this helper runs before the
    // body is read, so nothing the client has seen is contradicted by a second
    // attempt — the stream has carried comments and no tokens.
    const retries: Array<[number, number, RetryCause]> = [];
    let calls = 0;
    const url = await serving((request, response) => {
      calls += 1;
      request.resume();
      if (calls === 1) {
        response.writeHead(502);
        response.end('<html><body>502 Bad Gateway</body></html>');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
      response.end('data: [DONE]\n\n');
    });

    const response = await call(url, {
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: { model: 'x', stream: true },
      responseTimeoutMs: RETRY_FITS_MS,
      onRetry: (...args) => retries.push(args),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    await expect(response.text()).resolves.toContain('[DONE]');
    expect(calls).toBe(2);
    expect(retries).toEqual([[1, 2, 'bad-gateway']]);
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

  it('gives up on a never-answered socket without retrying: bytes may already have landed', async () => {
    // Retrying here could re-run a generation the upstream had already started:
    // the socket was accepted, so the request bytes may be on it.
    const retries: number[] = [];
    const url = await serving((request) => {
      // Accepted at the TCP level and then ignored for ever, which is the hang the
      // deadline exists for.
      request.resume();
    });

    const failure = await call(url, { responseTimeoutMs: 40, onRetry: (attempt) => retries.push(attempt) }).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(UpstreamTimeoutError);
    // The deadline reads as itself. Rounding it to whole seconds would print "0s"
    // to a client whose deployment configured a sub-second one.
    expect((failure as Error).message).toContain('0.04s');
    expect(retries).toEqual([]);
  });

  it('waits past the old 5s ceiling for an upstream that is simply still working', async () => {
    const url = await serving((request, response) => {
      request.resume();
      // Longer than the 5s the deadline used to allow, shorter than what a real
      // `connectTimeout + readTimeout` now permits.
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"ok":true}');
      }, 120);
    });

    const response = await call(url, { responseTimeoutMs: 2_000 });

    expect(response.status).toBe(200);
  });
});
