import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthRequestError, requestSignInCode, signInDestination, signInWithCode, signOut } from './auth';
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

/**
 * Sign-in by mailed code (SUP-269): two requests, and the second one is also
 * how an account is created.
 */
describe('sign-in by emailed code', () => {
  function stubFetch(response: Response) {
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  function sent(fetchMock: ReturnType<typeof vi.fn>): {
    url: string;
    init: RequestInit;
    body: Record<string, unknown>;
  } {
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    return { url, init, body: JSON.parse(init.body as string) };
  }

  it('asks for a sign-in code by address, with the session cookie allowed to travel', async () => {
    const fetchMock = stubFetch(new Response('{"success":true}', { status: 200 }));

    await requestSignInCode('dev@example.com');

    const { url, init, body } = sent(fetchMock);
    expect(url).toMatch(/\/auth\/email-otp\/send-verification-otp$/);
    expect(body).toEqual({ email: 'dev@example.com', type: 'sign-in' });
    expect(init.credentials).toBe('include');
  });

  it('hands the code back under the name the router gives it', async () => {
    const fetchMock = stubFetch(new Response('{}', { status: 200 }));

    await signInWithCode({ email: 'dev@example.com', code: '123456' });

    const { url, init, body } = sent(fetchMock);
    expect(url).toMatch(/\/auth\/sign-in\/email-otp$/);
    // Nothing else: a name and an invitation mean something only when the
    // request creates the account, and are left out rather than sent empty.
    expect(body).toEqual({ email: 'dev@example.com', otp: '123456' });
    expect(init.credentials).toBe('include');
  });

  it('carries a name and an invitation for the account the request may create', async () => {
    const fetchMock = stubFetch(new Response('{}', { status: 200 }));

    await signInWithCode({ email: 'dev@example.com', code: '123456', name: '  Dev Eloper ', inviteCode: 'ABCDEFGH' });

    expect(sent(fetchMock).body).toEqual({
      email: 'dev@example.com',
      otp: '123456',
      name: 'Dev Eloper',
      inviteCode: 'ABCDEFGH',
    });
  });

  it('leaves out a blank name and an absent invitation', async () => {
    const fetchMock = stubFetch(new Response('{}', { status: 200 }));

    await signInWithCode({ email: 'dev@example.com', code: '123456', name: '   ', inviteCode: null });

    expect(sent(fetchMock).body).toEqual({ email: 'dev@example.com', otp: '123456' });
  });

  it('never puts the code in the URL', async () => {
    const fetchMock = stubFetch(new Response('{}', { status: 200 }));

    await signInWithCode({ email: 'dev@example.com', code: '123456' });

    expect(sent(fetchMock).url).not.toContain('123456');
  });

  it('reports a refusal with the status and the code the screens tell them apart by', async () => {
    stubFetch(new Response('{"code":"OTP_EXPIRED","message":"OTP expired"}', { status: 400 }));

    const refusal = await signInWithCode({ email: 'dev@example.com', code: '123456' }).catch((error) => error);

    expect(refusal).toBeInstanceOf(AuthRequestError);
    expect(refusal).toMatchObject({ status: 400, code: 'OTP_EXPIRED' });
  });
});
