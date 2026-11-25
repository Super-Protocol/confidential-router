import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { postToUpstream, type RetryCause, UpstreamTimeoutError, UpstreamUnavailableError } from './upstream-fetch.js';

/**
 * The retry rules both legs share, and the properties that make them safe.
 *
 * A refused connection is retried on either leg. A proxy-generated 5xx is
 * retried on the **external** leg only, and only when nothing of it has been
 * relayed — which is always, because this helper returns before the upstream's
 * body is read. Neither kind of answer carries `usage`, so neither can bill a
 * caller twice; the cost of being wrong is one duplicate generation on our own
 * GPU (SUP-917). Extracted for the external egress leg (ADR-008 §4), so it is
 * worth one spec rather than two copies of a comment.
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
    responseTimeoutMs: 2_000,
    signal: AbortSignal.timeout(20_000),
    retryProxyFailure: true,
    ...overrides,
  });
}

/** Answers `status` once, then 200, counting what it was asked. */
async function failsThenSucceeds(status: number, body = '{}'): Promise<{ url: string; calls: () => number }> {
  let calls = 0;
  const url = await serving((request, response) => {
    calls += 1;
    request.resume();
    if (calls === 1) {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(body);
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
  });
  return { url, calls: () => calls };
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

  it.each([502, 503, 504])('retries a proxy-generated %i and returns the second attempt’s answer', async (status) => {
    // The SUP-917 shape: a proxy in front of the model could not deliver the
    // request, so no generation ran and it can go again. One of the model
    // cloud's three nodes does this; the retry lands on another one.
    const retries: Array<[number, number, RetryCause]> = [];
    const upstream = await failsThenSucceeds(status);

    const response = await call(upstream.url, { onRetry: (...args) => retries.push(args) });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(upstream.calls()).toBe(2);
    expect(retries).toEqual([[1, 2, { kind: 'proxy-failure', status }]]);
  });

  it('never retries a proxy failure on the leg that did not ask for it', async () => {
    // LiteLLM is in this cluster space with nothing in front of it, so its 5xx
    // is its own answer about its upstream — which may have generated.
    const retries: number[] = [];
    const upstream = await failsThenSucceeds(502);

    const response = await call(upstream.url, {
      retryProxyFailure: false,
      onRetry: (attempt) => retries.push(attempt),
    });

    expect(response.status).toBe(502);
    expect(upstream.calls()).toBe(1);
    expect(retries).toEqual([]);
  });

  it('does not retry the egress sidecar’s own fail-closed 503', async () => {
    // `gatekeeper_error` is a policy refusal, and retrying an attestation
    // failure is the one thing this helper must never do. Only the body tells it
    // apart from a model server's 503.
    const retries: number[] = [];
    const upstream = await failsThenSucceeds(
      503,
      JSON.stringify({ error: { type: 'gatekeeper_error', message: 'no valid verdict' }, stage: 'policy' }),
    );

    const response = await call(upstream.url, { onRetry: (attempt) => retries.push(attempt) });

    expect(response.status).toBe(503);
    // Read off a clone, so the caller's body is still there for `mapFailure`.
    await expect(response.json()).resolves.toMatchObject({ error: { type: 'gatekeeper_error' } });
    expect(upstream.calls()).toBe(1);
    expect(retries).toEqual([]);
  });

  it('surfaces the second proxy failure exactly as a client sees one today', async () => {
    const retries: Array<[number, number, RetryCause]> = [];
    let calls = 0;
    const url = await serving((request, response) => {
      calls += 1;
      request.resume();
      response.writeHead(502, { 'content-type': 'text/html' });
      response.end('<html><body>502 Bad Gateway</body></html>');
    });

    const response = await call(url, { onRetry: (...args) => retries.push(args) });

    expect(response.status).toBe(502);
    // A readable body, not one this helper already cancelled: `mapFailure` reads
    // it to decide what the caller is told.
    await expect(response.text()).resolves.toContain('502 Bad Gateway');
    expect(calls).toBe(2);
    expect(retries).toEqual([[1, 2, { kind: 'proxy-failure', status: 502 }]]);
  });

  it('does not retry when the budget left cannot fit another attempt that size', async () => {
    // The failure this exists for takes 60 s and a second would take 60 s more.
    // Against a deadline that cannot hold both, the caller keeps the 502 it has
    // rather than being handed an `upstream_timeout` that says less.
    const retries: number[] = [];
    let calls = 0;
    const url = await serving((request, response) => {
      calls += 1;
      request.resume();
      // Comfortably inside the deadline, and comfortably more than half of it.
      setTimeout(() => {
        response.writeHead(502);
        response.end('{}');
      }, 160);
    });

    const response = await call(url, { responseTimeoutMs: 250, onRetry: (attempt) => retries.push(attempt) });

    expect(response.status).toBe(502);
    expect(calls).toBe(1);
    expect(retries).toEqual([]);
  });

  it('retries when the budget left can fit another attempt that size', async () => {
    // The same upstream against a deadline with room for two, so the rule is
    // pinned from both sides rather than only where it refuses.
    const retries: number[] = [];
    let calls = 0;
    const url = await serving((request, response) => {
      calls += 1;
      request.resume();
      if (calls === 1) {
        setTimeout(() => {
          response.writeHead(502);
          response.end('{}');
        }, 160);
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });

    const response = await call(url, { responseTimeoutMs: 2_000, onRetry: (attempt) => retries.push(attempt) });

    expect(response.status).toBe(200);
    expect(calls).toBe(2);
    expect(retries).toEqual([1]);
  });

  it('does not dispatch the retry once the caller has gone between attempts', async () => {
    // The hang-up lands after the 502 and before the second attempt leaves,
    // which is the window `onRetry` sits in. The retry must not be sent: there
    // is nobody to hand its answer to, and it would cost a generation.
    const abort = new AbortController();
    let calls = 0;
    const url = await serving((request, response) => {
      calls += 1;
      request.resume();
      response.writeHead(502);
      response.end('{}');
    });

    await expect(
      call(url, {
        signal: abort.signal,
        onRetry: () => abort.abort(new Error('the client left')),
      }),
    ).rejects.toThrow('the client left');

    // The second attempt was abandoned before it reached the upstream, and the
    // abort is reported as itself rather than wrapped as an unreachable upstream.
    expect(calls).toBe(1);
  });

  it('does not retry when the caller hangs up while the upstream is deciding', async () => {
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

    await expect(call(url, { signal: abort.signal, onRetry: (a) => retries.push(a) })).rejects.toThrow();

    expect(calls).toBe(1);
    expect(retries).toEqual([]);
  });

  it('retries a proxy failure on a streamed request too — the open stream carries no tokens yet', async () => {
    // By the time one of these arrives the router has usually opened its SSE
    // stream and is heartbeating into it (SUP-449), so the status line is gone.
    // That is exactly why the retry belongs here: heartbeat comments are not
    // relayed upstream bytes, so nothing the client has seen is contradicted —
    // the stream has carried comments and no tokens.
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
      onRetry: (...args) => retries.push(args),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    await expect(response.text()).resolves.toContain('[DONE]');
    expect(calls).toBe(2);
    expect(retries).toEqual([[1, 2, { kind: 'proxy-failure', status: 502 }]]);
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
