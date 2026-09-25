import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  forgetInvite,
  INVITE_COOKIE_NAME,
  INVITE_STORAGE_KEY,
  inviteContextOf,
  inviteCookie,
  inviteCookieScope,
  normaliseInviteCode,
  publishInviteCookie,
  readInviteCode,
  rememberInvite,
  withInvite,
} from './invite';

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  // biome-ignore lint/suspicious/noDocumentCookie: clearing the cookie the code under test set, with the API the code under test uses.
  document.cookie = `${INVITE_COOKIE_NAME}=; max-age=0; path=/`;
});

describe('normaliseInviteCode', () => {
  it('agrees with router-api: upper case, separators gone', () => {
    // The server stores the normalised form and normalises every lookup, which is
    // what makes the match case-insensitive as a plain unique-index hit.
    expect(normaliseInviteCode('abcd-efgh-jklm')).toBe('ABCDEFGHJKLM');
    expect(normaliseInviteCode('  abcd efgh  jklm ')).toBe('ABCDEFGHJKLM');
  });
});

describe('readInviteCode', () => {
  it('prefers the URL over anything this browser remembered', () => {
    window.localStorage.setItem(INVITE_STORAGE_KEY, 'OLDCODE');

    // A stored code belongs to an earlier visit; the URL is this visitor's.
    expect(readInviteCode('?invite=abcd-efgh')).toBe('ABCDEFGH');
  });

  it('falls back to storage, which is what survives a reload', () => {
    rememberInvite('abcd-efgh');

    expect(readInviteCode('')).toBe('ABCDEFGH');
  });

  it('is null when there is nothing, and after the code is forgotten', () => {
    expect(readInviteCode('')).toBeNull();

    rememberInvite('ABCDEFGH');
    forgetInvite();
    expect(readInviteCode('')).toBeNull();
  });

  it('treats an empty parameter as no code at all', () => {
    expect(readInviteCode('?invite=')).toBeNull();
    expect(readInviteCode('?invite=%20%20')).toBeNull();
  });

  it('works in a browser that refuses storage', () => {
    // A visitor with storage blocked still has the code in the URL, which is the
    // source that matters.
    expect(readInviteCode('?invite=abcd', null)).toBe('ABCD');
    expect(readInviteCode('', null)).toBeNull();
  });
});

describe('inviteContextOf', () => {
  it('reads a mailing click as landing_cta, with the campaign as the marketer wrote it', () => {
    const context = inviteContextOf('?invite=abcd&utm_source=email&utm_campaign=Launch-2026-10');

    expect(context).toEqual({ code: 'ABCD', utmCampaign: 'launch-2026-10', entry: 'landing_cta' });
  });

  it('reads an invitation URL opened straight at the console as invite_link', () => {
    expect(inviteContextOf('?invite=abcd').entry).toBe('invite_link');
  });

  it('reads the sign-in screen’s own link as login_switch', () => {
    expect(inviteContextOf('?from=login').entry).toBe('login_switch');
  });

  it('reads a bare visit as direct', () => {
    expect(inviteContextOf('')).toEqual({ code: null, utmCampaign: null, entry: 'direct' });
  });
});

describe('withInvite', () => {
  it('appends the code to a path, keeping it a path', () => {
    expect(withInvite('/', 'ABCD')).toBe('/?invite=ABCD');
    expect(withInvite('/welcome?x=1', 'ABCD')).toBe('/welcome?x=1&invite=ABCD');
  });

  it('appends the code to an absolute URL', () => {
    expect(withInvite('https://console.example.com/', 'ABCD')).toBe('https://console.example.com/?invite=ABCD');
  });

  it('leaves the URL alone when there is no code', () => {
    expect(withInvite('/', null)).toBe('/');
  });
});

describe('publishInviteCookie', () => {
  it('sets the cookie router-api reads out of an OAuth callback', () => {
    publishInviteCookie('abcd-efgh');

    // The only hop the URL cannot cross: the callback is a URL the provider
    // built, and `localStorage` is not readable from the API's origin.
    expect(document.cookie).toContain(`${INVITE_COOKIE_NAME}=ABCDEFGH`);
  });
});

/**
 * The `Domain` attribute, asserted on the string.
 *
 * It cannot be asserted any other way here: jsdom, the compose demo and the
 * Playwright loopback topology all serve the console and the API from one host,
 * and that is the single arrangement in which a host-only cookie reaches the
 * callback. A deployment puts them on sibling hosts, where a cookie with no
 * `Domain` is sent to neither.
 */
describe('inviteCookieScope', () => {
  it('scopes to the suffix two sibling hosts share', () => {
    // The deployment's own host scheme (ADR-006): the API is a sibling of the
    // console, so host-only would never arrive.
    expect(inviteCookieScope('console.router.superprotocol.com', 'api.router.superprotocol.com')).toBe(
      'router.superprotocol.com',
    );
    expect(inviteCookieScope('console.example.com', 'api.example.com')).toBe('example.com');
  });

  it('scopes to the registrable domain when the console is served from it', () => {
    // `example.com` is settable from `example.com` and reaches `api.example.com`;
    // host-only would reach only the console.
    expect(inviteCookieScope('example.com', 'api.example.com')).toBe('example.com');
  });

  it('takes the longest shared suffix, not the registrable domain', () => {
    // The tightest scope that still reaches the API. Widening to
    // `superprotocol.com` would hand the code to every unrelated host under it.
    expect(inviteCookieScope('console.router.superprotocol.com', 'api.router.superprotocol.com')).not.toBe(
      'superprotocol.com',
    );
  });

  it('stays host-only where the two apps share a host', () => {
    // Compose and `nx serve`: host-only already reaches the API and is narrower.
    expect(inviteCookieScope('localhost', 'localhost')).toBeNull();
    expect(inviteCookieScope('127.0.0.1', '127.0.0.1')).toBeNull();
  });

  it('refuses a scope no browser would accept', () => {
    // A public suffix, a bare name, and an IP literal — a `Domain` of any of the
    // three is dropped, which would lose the cookie rather than widen it.
    expect(inviteCookieScope('console.localhost', 'api.localhost')).toBeNull();
    expect(inviteCookieScope('console.example.com', 'api.example.org')).toBeNull();
    expect(inviteCookieScope('10.0.0.1', '10.0.0.2')).toBeNull();
  });

  it('is case-insensitive, as hostnames are', () => {
    expect(inviteCookieScope('Console.Router.Example.COM', 'api.router.example.com')).toBe('router.example.com');
  });
});

describe('inviteCookie', () => {
  const HOSTS = { consoleHost: 'console.router.superprotocol.com', apiHost: 'api.router.superprotocol.com' };

  it('carries the normalised code, the scope and the flags', () => {
    const cookie = inviteCookie('abcd-efgh-jklm', { ...HOSTS, secure: true });

    expect(cookie).toContain(`${INVITE_COOKIE_NAME}=ABCDEFGHJKLM`);
    // Without this the OAuth callback never sees the cookie, and the grant is
    // lost with no error anywhere.
    expect(cookie).toContain('domain=router.superprotocol.com');
    // Lax, not Strict: the callback arrives as a top-level cross-site GET, which
    // Strict would refuse and Lax permits.
    expect(cookie).toContain('samesite=lax');
    expect(cookie).toContain('path=/');
    expect(cookie).toContain('secure');
  });

  it('omits Secure on http, where the browser would drop the cookie for it', () => {
    expect(inviteCookie('ABCD', { ...HOSTS, secure: false })).not.toContain('secure');
  });

  it('omits Domain entirely where there is no scope to set', () => {
    const cookie = inviteCookie('ABCD', { consoleHost: 'localhost', apiHost: 'localhost', secure: false });

    expect(cookie).not.toContain('domain=');
    expect(cookie).toContain(`${INVITE_COOKIE_NAME}=ABCD`);
  });

  it('expires in minutes, because it covers one round trip and not a session', () => {
    expect(inviteCookie('ABCD', { ...HOSTS, secure: false })).toContain('max-age=900');
  });
});
