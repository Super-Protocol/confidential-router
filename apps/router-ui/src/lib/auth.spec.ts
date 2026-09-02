import { afterEach, describe, expect, it, vi } from 'vitest';
import { signInDestination, signOut } from './auth';
import { clearSignedIn, markSignedIn, SIGNED_IN_COOKIE_NAME } from './signed-in-cookie';

afterEach(() => {
  clearSignedIn();
  vi.unstubAllGlobals();
});

describe('signInDestination', () => {
  it('honours the path the proxy denied', () => {
    expect(signInDestination('?next=%2Flogs%3Fstatus%3DERROR')).toBe('/logs?status=ERROR');
  });

  it('falls back to the configured callback when there is nowhere to go back to', () => {
    expect(signInDestination('')).toBe('/');
  });

  it('refuses an absolute URL, so the console cannot be used as an open redirector', () => {
    expect(signInDestination('?next=https%3A%2F%2Fevil.example')).toBe('/');
  });

  it('refuses a protocol-relative one, which a browser also reads as an origin', () => {
    expect(signInDestination('?next=%2F%2Fevil.example')).toBe('/');
    expect(signInDestination('?next=%2F%5Cevil.example')).toBe('/');
  });
});

describe('signOut', () => {
  it('takes the routing marker down with the session', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    markSignedIn();

    await signOut();

    expect(document.cookie).not.toContain(SIGNED_IN_COOKIE_NAME);
  });

  it('takes it down even when the API cannot be reached', async () => {
    // Otherwise a viewer who asked to leave is bounced back into a console that
    // may or may not still answer them.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    markSignedIn();

    await expect(signOut()).rejects.toThrow();
    expect(document.cookie).not.toContain(SIGNED_IN_COOKIE_NAME);
  });
});
