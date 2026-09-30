import { describe, expect, it, vi } from 'vitest';
import {
  BRIDGE_VERSION,
  EXTENSION_SOURCE,
  type ExtensionVerdict,
  PAGE_SOURCE,
  requestExtensionVerification,
  verdictOf,
} from './extension-bridge';

/**
 * A stand-in for the page's own window: it records what the page posted and lets
 * a test play the content script's reply back.
 */
function fakeWindow() {
  const listeners = new Set<(event: MessageEvent) => void>();
  const posted: unknown[] = [];

  const target = {
    postMessage: (message: unknown) => posted.push(message),
    addEventListener: (_type: string, listener: EventListener) => {
      listeners.add(listener as (event: MessageEvent) => void);
    },
    removeEventListener: (_type: string, listener: EventListener) => {
      listeners.delete(listener as (event: MessageEvent) => void);
    },
  };

  return {
    target,
    posted,
    listenerCount: () => listeners.size,
    reply(data: unknown) {
      for (const listener of [...listeners]) {
        listener({ data, source: target } as unknown as MessageEvent);
      }
    },
  };
}

function reply(
  id: string,
  overrides: Partial<ExtensionVerdict & { source: string; version: number; type: string; id: string }> = {},
) {
  return {
    source: EXTENSION_SOURCE,
    version: BRIDGE_VERSION,
    type: 'verify-result',
    id,
    ok: true,
    ...overrides,
  };
}

describe('requestExtensionVerification', () => {
  it('posts a versioned request naming the hostname to check', async () => {
    const window = fakeWindow();
    const pending = requestExtensionVerification({
      hostname: 'router.example.test',
      target: window.target,
      timeoutMs: 5,
    });

    expect(window.posted).toHaveLength(1);
    expect(window.posted[0]).toMatchObject({
      source: PAGE_SOURCE,
      version: BRIDGE_VERSION,
      type: 'verify-request',
      hostname: 'router.example.test',
    });

    await pending;
  });

  it('reports an absent extension rather than an error, and stops listening', async () => {
    // The common case: no extension installed. It must never block the composer
    // and never surface as a failure about the endpoint.
    const window = fakeWindow();

    const outcome = await requestExtensionVerification({ hostname: 'a.test', target: window.target, timeoutMs: 5 });

    expect(outcome).toEqual({ status: 'absent' });
    expect(window.listenerCount()).toBe(0);
  });

  it('surfaces a pass with what the extension established', async () => {
    const window = fakeWindow();
    const pending = requestExtensionVerification({ hostname: 'a.test', target: window.target, timeoutMs: 50 });
    const id = (window.posted[0] as { id: string }).id;

    window.reply(reply(id, { rootName: 'Super Swarm Root CA', channelBinding: 'producer-asserted' }));

    await expect(pending).resolves.toEqual({
      status: 'verified',
      verdict: {
        ok: true,
        rootName: 'Super Swarm Root CA',
        channelBinding: 'producer-asserted',
        stage: undefined,
        reason: undefined,
        extensionVersion: undefined,
      },
    });
  });

  it('surfaces a refusal as a refusal, not as an absent extension', async () => {
    const window = fakeWindow();
    const pending = requestExtensionVerification({ hostname: 'a.test', target: window.target, timeoutMs: 50 });
    const id = (window.posted[0] as { id: string }).id;

    window.reply(reply(id, { ok: false, stage: 'untrusted-root', reason: 'not in trust store' }));

    const outcome = await pending;
    expect(outcome.status).toBe('refused');
  });

  it('ignores an answer to somebody else’s question', async () => {
    const window = fakeWindow();
    const pending = requestExtensionVerification({ hostname: 'a.test', target: window.target, timeoutMs: 20 });

    window.reply(reply('a-different-request'));

    await expect(pending).resolves.toEqual({ status: 'absent' });
  });

  it('defaults to the page’s own window, where a content script listens', async () => {
    // No target passed: the page posts into itself, which is the only channel a
    // page and an extension share without the page knowing the extension's id.
    const posted = vi.spyOn(window, 'postMessage');

    const outcome = await requestExtensionVerification({ hostname: 'a.test', timeoutMs: 5 });

    expect(posted).toHaveBeenCalledWith(expect.objectContaining({ source: PAGE_SOURCE }), '*');
    expect(outcome).toEqual({ status: 'absent' });
    posted.mockRestore();
  });
});

describe('verdictOf', () => {
  const event = (data: unknown): MessageEvent => ({ data }) as MessageEvent;

  it('accepts a well-formed answer', () => {
    expect(verdictOf(event(reply('req-1')), 'req-1')?.ok).toBe(true);
  });

  it('rejects anything not announcing itself as the extension', () => {
    // Any page on the internet can post into this window. The source marker, the
    // message type and the correlation id are what keep a stranger's message from
    // being read as a verification result.
    expect(verdictOf(event({ ...reply('req-1'), source: 'evil.example' }), 'req-1')).toBeNull();
    expect(verdictOf(event({ ...reply('req-1'), type: 'something-else' }), 'req-1')).toBeNull();
    expect(verdictOf(event(null), 'req-1')).toBeNull();
    expect(verdictOf(event('a string'), 'req-1')).toBeNull();
  });

  it('rejects a protocol version it was not built against', () => {
    // The two halves ship from different repositories. A future extension that
    // changes the shape must not have its answer read under the old rules.
    expect(verdictOf(event({ ...reply('req-1'), version: BRIDGE_VERSION + 1 }), 'req-1')).toBeNull();
  });

  it('rejects an answer with no verdict in it', () => {
    expect(verdictOf(event({ ...reply('req-1'), ok: 'yes' }), 'req-1')).toBeNull();
  });

  it('drops fields it does not recognise rather than passing them through', () => {
    const verdict = verdictOf(event({ ...reply('req-1'), channelBinding: 'vibes', rootName: 42 }), 'req-1');

    expect(verdict).toMatchObject({ ok: true, channelBinding: undefined, rootName: undefined });
  });
});
