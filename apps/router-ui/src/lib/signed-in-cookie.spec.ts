import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearSignedIn, markSignedIn, SIGNED_IN_COOKIE_NAME } from './signed-in-cookie';

/**
 * The exact string written to `document.cookie`.
 *
 * jsdom stores a `Secure` cookie whether or not the page is https, so the store
 * cannot show which attributes were asked for — and the attributes are the part
 * a browser acts on.
 */
function attributesWritten(write: () => void): string {
  const written: string[] = [];
  Object.defineProperty(document, 'cookie', { configurable: true, set: (v: string) => written.push(v), get: () => '' });
  try {
    write();
  } finally {
    // Drops the own property and uncovers jsdom's real accessor again.
    delete (document as unknown as Record<string, unknown>).cookie;
  }
  return written.join('\n');
}

afterEach(() => {
  clearSignedIn();
  vi.unstubAllGlobals();
});

describe('the signed-in marker', () => {
  it('raises a cookie the proxy can read', () => {
    markSignedIn();

    expect(document.cookie.split('; ')).toContain(`${SIGNED_IN_COOKIE_NAME}=1`);
  });

  it('takes it down again', () => {
    markSignedIn();
    clearSignedIn();

    expect(document.cookie).not.toContain(SIGNED_IN_COOKIE_NAME);
  });

  it('is readable by the client that writes it, unlike the API session cookie', () => {
    // `document.cookie` only ever exposes cookies that are not HttpOnly, so
    // reading the marker back *is* the assertion. It has to be writable here:
    // the console, not router-api, is what raises it.
    markSignedIn();

    expect(document.cookie).toContain(SIGNED_IN_COOKIE_NAME);
  });

  it('scopes the cookie to the whole console and keeps it same-site', () => {
    expect(attributesWritten(markSignedIn)).toContain('path=/; samesite=lax');
  });

  it('is Secure on https, which every deployment is', () => {
    vi.stubGlobal('location', { ...window.location, protocol: 'https:' });

    expect(attributesWritten(markSignedIn)).toContain('secure');
  });

  it('is not Secure on http, where the browser would drop it without a word', () => {
    // The compose demo and the e2e stack both serve the console over plain http;
    // a marker the browser discards there bounces a browser that just signed in.
    expect(window.location.protocol).toBe('http:');

    expect(attributesWritten(markSignedIn)).not.toContain('secure');
  });
});
