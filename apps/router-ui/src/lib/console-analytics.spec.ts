import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONSOLE_EVENTS_PATH, captureConsoleEvent } from './console-analytics';
import { PUBLIC_CONFIG_GLOBAL } from './public-config';

/**
 * The console half of SUP-463.
 *
 * The ingest's first path, `/v1/analytics/events`, matched EasyPrivacy's
 * unanchored `/analytics/event` rule, which ships enabled in uBlock Origin,
 * Brave Shields and AdGuard — so the request was cancelled in the browser and
 * `signup_started` simply never existed for much of the audience we were
 * measuring. Being first-party only escapes a blocklist's *domain* rules.
 *
 * Hence an assertion on the literal: a rename back to anything the lists are
 * written with has to fail here, because nothing about a blocked event looks
 * like a failure anywhere else — `captureConsoleEvent` is silent by design.
 */

/** The words the blocklists' path rules are written with. Mirrors the router-api spec. */
const BLOCKED_WORDS = ['analytics', '/event', 'track', 'collect', 'telemetry', 'pixel', 'beacon', 'stats'];

const injected = globalThis as unknown as Record<string, unknown>;
const fetchMock = vi.fn();

beforeEach(() => {
  injected[PUBLIC_CONFIG_GLOBAL] = {
    apiOrigin: 'https://api.example.com',
    graphqlHttp: 'https://api.example.com/graphql',
    authCallbackUrl: '/',
    swarmRootPemUrl: 'https://router.superprotocol.com/swarm-root.pem',
  };
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, status: 202 });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  delete injected[PUBLIC_CONFIG_GLOBAL];
  vi.unstubAllGlobals();
});

describe('the ingest path', () => {
  it.each(BLOCKED_WORDS)('does not contain "%s"', (word) => {
    expect(CONSOLE_EVENTS_PATH).not.toContain(word);
  });

  it('is the path router-api serves', () => {
    expect(CONSOLE_EVENTS_PATH).toBe('/v1/console-events');
  });
});

describe('captureConsoleEvent', () => {
  it('posts the event to the ingest on the API origin, with the session cookie', async () => {
    await captureConsoleEvent('signup_started', { has_invite: true, entry: 'landing_cta' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.com/v1/console-events');
    expect(init).toMatchObject({ method: 'POST', credentials: 'include', keepalive: true });
    expect(JSON.parse(init.body as string)).toEqual({
      event: 'signup_started',
      properties: { has_invite: true, entry: 'landing_cta' },
    });
  });

  it('omits an absent property rather than sending it as null', async () => {
    await captureConsoleEvent('signup_started', { has_invite: false, campaign: undefined });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).properties).toEqual({ has_invite: false });
  });

  it('resolves when the request is refused, because analytics must not break a screen', async () => {
    // What a blocker actually does to this call: the fetch rejects. A thrown
    // error here would have surfaced as a broken sign-up screen.
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(captureConsoleEvent('signup_started', { entry: 'direct' })).resolves.toBeUndefined();
  });
});
