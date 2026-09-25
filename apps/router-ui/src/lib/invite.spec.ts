import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  forgetInvite,
  INVITE_COOKIE_NAME,
  INVITE_STORAGE_KEY,
  inviteContextOf,
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
