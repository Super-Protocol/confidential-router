import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { SIGNED_IN_COOKIE_NAME } from './lib/signed-in-cookie';
import proxy from './proxy';

function requestFor(path: string, options: { session?: boolean; apiCookies?: boolean } = {}): NextRequest {
  const request = new NextRequest(new URL(path, 'https://console.example.com'));
  if (options.session) request.cookies.set(SIGNED_IN_COOKIE_NAME, '1');
  // What a browser would carry if router-api shared the console's hostname —
  // which is the assumption that produced SUP-113.
  if (options.apiCookies) {
    request.cookies.set('cr_session', 'opaque-token');
    request.cookies.set('__Secure-cr_session', 'opaque-token');
  }
  return request;
}

describe('proxy', () => {
  it('sends a signed-out browser to the sign-in screen', () => {
    const response = proxy(requestFor('/models'));

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get('location') as string);
    expect(location.pathname).toBe('/login');
  });

  it('remembers where the viewer was going', () => {
    const response = proxy(requestFor('/logs?status=ERROR'));
    const location = new URL(response.headers.get('location') as string);

    expect(location.searchParams.get('next')).toBe('/logs?status=ERROR');
  });

  it('does not add a redundant `next` for the root path', () => {
    const response = proxy(requestFor('/'));
    const location = new URL(response.headers.get('location') as string);

    expect(location.searchParams.has('next')).toBe(false);
  });

  it('lets a signed-out browser reach the sign-in screen', () => {
    const response = proxy(requestFor('/login'));

    expect(response.headers.get('location')).toBeNull();
  });

  it('lets a signed-out browser reach the sign-up screen', () => {
    const response = proxy(requestFor('/signup'));

    expect(response.headers.get('location')).toBeNull();
  });

  it('sends a signed-in browser away from the sign-up screen too', () => {
    const response = proxy(requestFor('/signup', { session: true }));
    const location = new URL(response.headers.get('location') as string);

    expect(location.pathname).toBe('/');
  });

  it('sends a signed-in browser away from the sign-in screen', () => {
    const response = proxy(requestFor('/login', { session: true }));
    const location = new URL(response.headers.get('location') as string);

    expect(location.pathname).toBe('/');
  });

  it('routes on the console\u2019s own marker, never on router-api\u2019s session cookie', () => {
    // The API's cookie is HttpOnly, host-only to the API's hostname, and named
    // `__Secure-cr_session` wherever it is worth having. On a deployment that
    // splits the two hosts it never reaches this middleware at all, so reading
    // it here can only ever be wrong \u2014 in either direction (SUP-113).
    const denied = proxy(requestFor('/models', { apiCookies: true }));
    expect(new URL(denied.headers.get('location') as string).pathname).toBe('/login');

    const allowed = proxy(requestFor('/models', { session: true, apiCookies: false }));
    expect(allowed.headers.get('location')).toBeNull();
  });

  it('lets a signed-in browser through to the console', () => {
    const response = proxy(requestFor('/activity', { session: true }));

    expect(response.headers.get('location')).toBeNull();
  });

  it('drops a `next` parameter forged onto the sign-in URL of a signed-in browser', () => {
    // Otherwise `/login?next=https://evil.example` would survive the bounce and
    // be handed to whatever consumes it after sign-in.
    const response = proxy(requestFor('/login?next=https://evil.example', { session: true }));
    const location = new URL(response.headers.get('location') as string);

    expect(location.search).toBe('');
  });
});
