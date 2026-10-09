/**
 * Password reset by mail, and the welcome mail (SUP-269).
 *
 * Every case boots the real application; only the hop out of the process is
 * replaced (`CapturingMailer`), so Better Auth's tokens, the throttles and the
 * decision whether to send at all are the production code. The suite that
 * speaks real SMTP is `mail-smtp.e2e.spec.ts`.
 */
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE_NAME } from '../src/app/auth/index.js';
import { createHarness, type Harness } from './app-harness.js';

const EMAIL = 'someone@example.com';
const PASSWORD = 'correct-horse-battery';
const NEW_PASSWORD = 'staple-new-horse-battery';
const ME_QUERY = '{ me { id email } }';
const OPTIONS_QUERY = '{ signInOptions { password passwordReset magicLink } }';
const CONSOLE = 'http://localhost:4200';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

/** Passwords on and a mailer configured — the marketplace listing with SMTP set. */
async function resetHarness(env: Record<string, string> = {}): Promise<Harness> {
  harness = await createHarness({
    env: {
      CR_API_AUTH__PASSWORD__ENABLED: 'true',
      CR_API_MAIL__PROVIDER: 'console',
      ...env,
    },
  });
  return harness;
}

function server(current: Harness) {
  return current.app.getHttpServer();
}

function cookiesOf(response: request.Response): string[] {
  const cookies = response.headers['set-cookie'];
  return (Array.isArray(cookies) ? cookies : [cookies].filter(Boolean)) as string[];
}

async function signUp(current: Harness, email = EMAIL): Promise<string[]> {
  const created = await request(server(current))
    .post('/auth/sign-up/email')
    .send({ email, password: PASSWORD, name: 'Some One' })
    .expect(200);
  return cookiesOf(created);
}

function requestReset(current: Harness, email: string) {
  return request(server(current)).post('/auth/request-password-reset').send({ email });
}

function resetPassword(current: Harness, token: string, newPassword = NEW_PASSWORD) {
  return request(server(current)).post('/auth/reset-password').send({ token, newPassword });
}

function signIn(current: Harness, password: string) {
  return request(server(current)).post('/auth/sign-in/email').send({ email: EMAIL, password });
}

async function me(current: Harness, cookies: string[]) {
  const response = await request(server(current)).post('/graphql').set('Cookie', cookies).send({ query: ME_QUERY });
  return response.body;
}

async function options(current: Harness) {
  const response = await request(server(current)).post('/graphql').send({ query: OPTIONS_QUERY }).expect(200);
  return response.body.data.signInOptions;
}

/** The token in the last reset mail, read from the link the way a reader would follow it. */
async function lastResetToken(current: Harness): Promise<string> {
  await current.settleMail();
  const mail = current.mailer.ofKind('password-reset').at(-1);
  if (!mail?.link) {
    throw new Error('No reset mail was sent.');
  }
  const link = new URL(mail.link);
  expect(`${link.origin}${link.pathname}`).toBe(`${CONSOLE}/reset-password`);
  const token = link.searchParams.get('token');
  if (!token) {
    throw new Error('The reset link carries no token.');
  }
  return token;
}

describe('password reset, with a mailer', () => {
  it('is offered on the sign-in screen', async () => {
    await expect(options(await resetHarness())).resolves.toEqual({
      password: true,
      passwordReset: true,
      magicLink: true,
    });
  });

  it('mails a console link, resets the password with it, and signs every old session out', async () => {
    const current = await resetHarness();
    const oldSession = await signUp(current);
    expect((await me(current, oldSession)).data.me.email).toBe(EMAIL);

    await requestReset(current, EMAIL).expect(200);
    const token = await lastResetToken(current);
    const mail = current.mailer.ofKind('password-reset').at(-1);
    expect(mail?.to).toBe(EMAIL);
    expect(mail?.text).toContain(token);

    await resetPassword(current, token).expect(200);

    // Better Auth's `revokeSessionsOnPasswordReset`: the session the old
    // password opened is gone.
    const after = await me(current, oldSession);
    expect(after.data).toBeNull();
    expect(after.errors?.[0]?.message).toContain('Authentication is required');

    await signIn(current, PASSWORD).expect(401);
    const fresh = await signIn(current, NEW_PASSWORD).expect(200);
    expect(cookiesOf(fresh).join(';')).toContain(SESSION_COOKIE_NAME);
  });

  it('accepts a token once', async () => {
    const current = await resetHarness();
    await signUp(current);
    await requestReset(current, EMAIL).expect(200);
    const token = await lastResetToken(current);

    await resetPassword(current, token).expect(200);
    const replay = await resetPassword(current, token, 'yet-another-password-1').expect(400);
    expect(replay.body.code).toBe('INVALID_TOKEN');

    await signIn(current, NEW_PASSWORD).expect(200);
  });

  it('refuses an expired token', async () => {
    const current = await resetHarness({ CR_API_AUTH__PASSWORD_RESET__TOKEN_TTL: '1s' });
    await signUp(current);
    await requestReset(current, EMAIL).expect(200);
    const token = await lastResetToken(current);

    await new Promise((resolve) => setTimeout(resolve, 1500));

    const expired = await resetPassword(current, token).expect(400);
    expect(expired.body.code).toBe('INVALID_TOKEN');
    await signIn(current, PASSWORD).expect(200);
  });

  it('refuses a made-up token and a password below the minimum', async () => {
    const current = await resetHarness();
    await signUp(current);

    expect((await resetPassword(current, 'not-a-real-token').expect(400)).body.code).toBe('INVALID_TOKEN');

    await requestReset(current, EMAIL).expect(200);
    const token = await lastResetToken(current);
    expect((await resetPassword(current, token, 'short').expect(400)).body.code).toBe('PASSWORD_TOO_SHORT');
  });

  it('answers identically whether or not the address has an account, and mails only the real one', async () => {
    const current = await resetHarness();
    await signUp(current);
    await current.settleMail();
    const before = current.mailer.messages.length;

    const known = await requestReset(current, EMAIL).expect(200);
    const unknown = await requestReset(current, 'nobody@example.com').expect(200);
    await current.settleMail();

    expect(unknown.body).toEqual(known.body);
    expect(Object.keys(unknown.headers).sort()).toEqual(Object.keys(known.headers).sort());
    const sent = current.mailer.messages.slice(before);
    expect(sent.map((message) => [message.kind, message.to])).toEqual([['password-reset', EMAIL]]);
  });

  it('ignores a client-supplied redirect: the link is the console’s, whatever the request said', async () => {
    const current = await resetHarness();
    await signUp(current);

    await request(server(current))
      .post('/auth/request-password-reset')
      .send({ email: EMAIL, redirectTo: 'http://localhost:4200/elsewhere' })
      .expect(200);

    await lastResetToken(current);
  });

  it('rate-limits requests per source address, for known and unknown addresses alike', async () => {
    const current = await resetHarness({ CR_API_AUTH__PASSWORD_RESET__REQUESTS_PER_MINUTE: '2' });
    await signUp(current);

    await requestReset(current, EMAIL).expect(200);
    await requestReset(current, 'nobody@example.com').expect(200);
    const known = await requestReset(current, EMAIL).expect(429);
    const unknown = await requestReset(current, 'nobody@example.com').expect(429);

    expect(known.body).toEqual({ code: 'RATE_LIMITED', message: expect.any(String) });
    expect(unknown.body).toEqual(known.body);
    expect(Number(known.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('mails one recipient at most its hourly allowance, without answering any differently', async () => {
    const current = await resetHarness({ CR_API_AUTH__PASSWORD_RESET__MAILS_PER_ADDRESS_PER_HOUR: '1' });
    await signUp(current);

    const first = await requestReset(current, EMAIL).expect(200);
    const second = await requestReset(current, EMAIL).expect(200);
    await current.settleMail();

    expect(second.body).toEqual(first.body);
    expect(current.mailer.ofKind('password-reset')).toHaveLength(1);
  });

  it('works on an invite-only deployment: resetting is signing in, not signing up', async () => {
    const token = 'bootstrap-token-'.padEnd(40, 'x');
    const current = await resetHarness({
      CR_API_AUTH__REQUIRE_INVITE_FOR_SIGN_UP: 'true',
      CR_API_AUTH__BOOTSTRAP_TOKEN: token,
      CR_API_AUTH__BOOTSTRAP_EMAIL: EMAIL,
    });
    // The bootstrapped administrator has no password at all; a reset gives it one.
    await request(server(current)).post('/auth/bootstrap').send({ token }).expect(200);

    await requestReset(current, EMAIL).expect(200);
    await resetPassword(current, await lastResetToken(current)).expect(200);

    await signIn(current, NEW_PASSWORD).expect(200);
    // And nobody new got in on the back of it.
    await request(server(current))
      .post('/auth/sign-up/email')
      .send({ email: 'new@example.com', password: PASSWORD, name: '' })
      .expect(403);
  });
});

describe('password reset, without a mailer', () => {
  async function mailless(): Promise<Harness> {
    harness = await createHarness({
      env: { CR_API_AUTH__PASSWORD__ENABLED: 'true', CR_API_AUTH__MAGIC_LINK__MAILER: 'none' },
    });
    return harness;
  }

  it('is not offered, and its routes do not exist', async () => {
    const current = await mailless();

    await expect(options(current)).resolves.toEqual({ password: true, passwordReset: false, magicLink: false });
    await requestReset(current, EMAIL).expect(404);
    await resetPassword(current, 'anything').expect(404);
  });

  it('sends nothing at sign-up — behaviour identical to before SUP-269', async () => {
    const current = await mailless();
    await signUp(current);
    await current.settleMail();

    expect(current.mailer.messages).toEqual([]);
  });

  it('is not offered when passwords are off, even with a mailer', async () => {
    harness = await createHarness({ env: { CR_API_MAIL__PROVIDER: 'console' } });

    await expect(options(harness)).resolves.toMatchObject({ password: false, passwordReset: false });
    await requestReset(harness, EMAIL).expect(404);
  });
});

describe('the welcome mail', () => {
  it('greets a password sign-up with the console URL and the credit it was granted', async () => {
    const current = await resetHarness({ CR_API_BILLING__SIGNUP_GRANT_MICROS: '20000000' });
    await signUp(current);
    await current.settleMail();

    const [welcome] = current.mailer.ofKind('welcome');
    expect(welcome).toMatchObject({ to: EMAIL, subject: 'Welcome to Confidential Router', link: CONSOLE });
    expect(welcome.text).toContain(`Console: ${CONSOLE}`);
    expect(welcome.text).toContain('Starting credit: $20');
    expect(welcome.html).toContain('Welcome, Some One');
  });

  it('greets a magic-link sign-up too, and names no credit when there was none', async () => {
    const current = await resetHarness();
    await request(server(current))
      .post('/auth/sign-in/magic-link')
      .send({ email: EMAIL, callbackURL: '/' })
      .expect(200);
    const url = new URL(current.mailer.last.url);
    await request(server(current)).get(`${url.pathname}${url.search}`);
    await current.settleMail();

    const [welcome] = current.mailer.ofKind('welcome');
    expect(welcome.to).toBe(EMAIL);
    expect(welcome.text).not.toContain('Starting credit');
  });

  it('is sent once per account, not on every sign-in', async () => {
    const current = await resetHarness();
    await signUp(current);
    await signIn(current, PASSWORD).expect(200);
    await signIn(current, PASSWORD).expect(200);
    await current.settleMail();

    expect(current.mailer.ofKind('welcome')).toHaveLength(1);
  });
});
