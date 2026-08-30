import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { SESSION_COOKIE_NAME } from './lib/env';
import proxy from './proxy';

function requestFor(path: string, options: { session?: boolean } = {}): NextRequest {
  const request = new NextRequest(new URL(path, 'https://console.example.com'));
  if (options.session) request.cookies.set(SESSION_COOKIE_NAME, 'opaque-token');
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

  it('sends a signed-in browser away from the sign-in screen', () => {
    const response = proxy(requestFor('/login', { session: true }));
    const location = new URL(response.headers.get('location') as string);

    expect(location.pathname).toBe('/');
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
