import { describe, expect, it } from 'vitest';
import { INVITE_COOKIE_NAME, type SignUpRequestContext, signUpInviteOf } from './sign-up-invite.js';

const CODE = 'ABCD-EFGH-JKMN';

function headers(entries: Record<string, string> = {}) {
  const lower = new Map(Object.entries(entries).map(([name, value]) => [name.toLowerCase(), value]));
  return { get: (name: string) => lower.get(name.toLowerCase()) ?? null };
}

function context(overrides: Partial<SignUpRequestContext> = {}): SignUpRequestContext {
  return { headers: headers(), ...overrides };
}

describe('finding the code', () => {
  it('reads the body field the console’s password sign-up sends', () => {
    expect(signUpInviteOf(context({ body: { email: 'a@b.test', inviteCode: CODE } })).code).toBe(CODE);
  });

  it('reads the query parameter the invitation URL uses', () => {
    expect(signUpInviteOf(context({ query: { invite: CODE } })).code).toBe(CODE);
  });

  it('reads it out of a callbackURL — the only thing a magic-link verify carries', () => {
    expect(signUpInviteOf(context({ query: { callbackURL: `/welcome?invite=${CODE}` } })).code).toBe(CODE);
  });

  it('reads it out of an absolute callbackURL too', () => {
    const callbackURL = `https://router.superprotocol.com/?invite=${CODE}&utm_source=email`;

    expect(signUpInviteOf(context({ query: { callbackURL } })).code).toBe(CODE);
  });

  it('reads the cookie, which is all that survives an OAuth round trip', () => {
    const cookie = `cr_session=abc; ${INVITE_COOKIE_NAME}=${CODE}; other=1`;

    expect(signUpInviteOf(context({ headers: headers({ cookie }) })).code).toBe(CODE);
  });

  it('percent-decodes the cookie', () => {
    const cookie = `${INVITE_COOKIE_NAME}=${encodeURIComponent(CODE)}`;

    expect(signUpInviteOf(context({ headers: headers({ cookie }) })).code).toBe(CODE);
  });

  it('prefers the body over the cookie: the request the console just made is the fresher intent', () => {
    const current = context({
      body: { inviteCode: CODE },
      headers: headers({ cookie: `${INVITE_COOKIE_NAME}=WXYZ-WXYZ-WXYZ` }),
    });

    expect(signUpInviteOf(current).code).toBe(CODE);
  });

  it('ignores a cookie whose name merely ends the same way', () => {
    const cookie = `not_${INVITE_COOKIE_NAME}=WXYZ-WXYZ-WXYZ`;

    expect(signUpInviteOf(context({ headers: headers({ cookie }) })).code).toBeNull();
  });

  it('treats an empty value as absent rather than as a code', () => {
    expect(signUpInviteOf(context({ body: { inviteCode: '   ' }, query: { invite: CODE } })).code).toBe(CODE);
  });

  it('survives a callbackURL that is not a URL at all', () => {
    expect(signUpInviteOf(context({ query: { callbackURL: '://%%%' } })).code).toBeNull();
  });

  it('returns nothing for a request that carried no code, and for no request at all', () => {
    expect(signUpInviteOf(context()).code).toBeNull();
    expect(signUpInviteOf(null).code).toBeNull();
    expect(signUpInviteOf(undefined).code).toBeNull();
  });
});

describe('the abuse-review fingerprint', () => {
  it('takes the first hop of x-forwarded-for, which is the one the proxy wrote', () => {
    const current = context({
      headers: headers({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1', 'user-agent': 'curl/8' }),
    });

    expect(signUpInviteOf(current)).toMatchObject({ ip: '203.0.113.7', userAgent: 'curl/8' });
  });

  it('falls back to x-real-ip', () => {
    expect(signUpInviteOf(context({ headers: headers({ 'x-real-ip': '203.0.113.9' }) })).ip).toBe('203.0.113.9');
  });

  it('is null when the request came with neither', () => {
    expect(signUpInviteOf(context())).toMatchObject({ ip: null, userAgent: null });
  });

  it('falls back to the request’s own headers when the context has none', () => {
    const current = { request: { headers: headers({ 'user-agent': 'Firefox' }) } };

    expect(signUpInviteOf(current).userAgent).toBe('Firefox');
  });
});
