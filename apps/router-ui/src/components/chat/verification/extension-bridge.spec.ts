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
      this.replyFrom(target, data);
    },
    /** Plays a message back as if it came from `source`, to test the channel check. */
    replyFrom(source: unknown, data: unknown) {
      for (const listener of [...listeners]) {
        listener({ data, source } as unknown as MessageEvent);
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

  it('ignores a verdict posted from another frame, and times out instead', async () => {
    // End to end through the listener, not only through `verdictOf`: the defect
    // this covers was a docstring that claimed the source check while the code
    // accepted any message whose *data* looked right.
    const window = fakeWindow();
    const pending = requestExtensionVerification({ hostname: 'a.test', target: window.target, timeoutMs: 20 });
    const id = (window.posted[0] as { id: string }).id;

    window.replyFrom({ name: 'someone-elses-frame' }, reply(id, { rootName: 'Attacker Root CA' }));

    await expect(pending).resolves.toEqual({ status: 'absent' });
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
  /** The window the page posted into, and therefore the only source it may hear from. */
  const ours = { name: 'our-window' };
  const event = (data: unknown, source: unknown = ours): MessageEvent => ({ data, source }) as MessageEvent;

  it('accepts a well-formed answer posted into our own window', () => {
    expect(verdictOf(event(reply('req-1')), 'req-1', ours)?.ok).toBe(true);
  });

  it('rejects an answer posted from anywhere but the window we posted into', () => {
    /*
     * The check the rest of this function cannot substitute for. Tier 2 is the
     * only path that upgrades the badge to "independently verified", and every
     * field below is a string an attacker can copy — so a frame that has a handle
     * on this one could otherwise mint a verdict by replaying a valid-looking
     * payload. Identity of the channel is the one part it cannot forge.
     */
    const otherFrame = { name: 'an-iframe-that-is-not-us' };

    expect(verdictOf(event(reply('req-1'), otherFrame), 'req-1', ours)).toBeNull();
    expect(verdictOf(event(reply('req-1'), null), 'req-1', ours)).toBeNull();
    // Built without the helper's default, so an event carrying no `source` at
    // all — which is what a non-window sender looks like — is covered too.
    expect(verdictOf({ data: reply('req-1') } as MessageEvent, 'req-1', ours)).toBeNull();
  });

  it('rejects anything not announcing itself as the extension', () => {
    // Belt and braces behind the source check: the type marker and the
    // correlation id keep an unrelated same-window message — our own request
    // echoing back, another library's chatter — from being read as a verdict.
    expect(verdictOf(event({ ...reply('req-1'), source: 'evil.example' }), 'req-1', ours)).toBeNull();
    expect(verdictOf(event({ ...reply('req-1'), type: 'something-else' }), 'req-1', ours)).toBeNull();
    expect(verdictOf(event(null), 'req-1', ours)).toBeNull();
    expect(verdictOf(event('a string'), 'req-1', ours)).toBeNull();
  });

  it('rejects a protocol version it was not built against', () => {
    // The two halves ship from different repositories. A future extension that
    // changes the shape must not have its answer read under the old rules.
    expect(verdictOf(event({ ...reply('req-1'), version: BRIDGE_VERSION + 1 }), 'req-1', ours)).toBeNull();
  });

  it('rejects an answer with no verdict in it', () => {
    expect(verdictOf(event({ ...reply('req-1'), ok: 'yes' }), 'req-1', ours)).toBeNull();
  });

  it('drops fields it does not recognise rather than passing them through', () => {
    const verdict = verdictOf(event({ ...reply('req-1'), channelBinding: 'vibes', rootName: 42 }), 'req-1', ours);

    expect(verdict).toMatchObject({ ok: true, channelBinding: undefined, rootName: undefined });
  });
});
