/**
 * Sign-in by emailed code against the built artefact (SUP-269) — how an account
 * signs in and how one is created, since there are no passwords.
 *
 * `apps/router-api/test/email-code.e2e.spec.ts` covers the behaviour. What only
 * a real process can show is here. The code is read the way a developer reads
 * it, out of the process's own log, where the development mailer writes it — so
 * this is the whole path from the request to the mail and back, through the
 * bundle that ships. Better Auth disables its own origin check inside a test
 * runner, so the CSRF guard on asking for a code is only observable from a
 * process that is not one. And the session token, the thing a code is traded
 * for, must not reach the log at the loudest setting.
 */
import {
  CONSOLE_ORIGIN,
  delay,
  demoRouterConfig,
  freePort,
  type RouterProcess,
  startRouterProcess,
} from '@confidential-router/demo';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const EMAIL = 'newcomer@example.test';
const SESSION_DAYS = 90;

let router: RouterProcess;
/** Every session token this suite was handed, to look for in the log at the end. */
const sessionTokens: string[] = [];

beforeAll(async () => {
  const port = await freePort();
  router = await startRouterProcess({
    port,
    env: {
      CR_API_SERVER__PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
      CR_API_AUTH__BASE_URL: `http://127.0.0.1:${port}`,
      // The development mailer: every code is written to this process's log,
      // which is the inbox this suite reads.
      CR_API_MAIL__PROVIDER: 'console',
      // The code is the only mail sign-in, as on a marketplace deployment.
      CR_API_AUTH__MAGIC_LINK__ENABLED: 'false',
      // Everything the process is willing to say, so "not in the log" is a
      // claim about the loudest setting rather than about the default one.
      CR_API_LOG__LEVEL: 'debug',
      // Vitest exports `TEST=true`, the child process inherits it, and Better
      // Auth reads it as "this is a test run" and turns its own origin check
      // off. Nothing under test here is a test runner, so clear it — otherwise
      // the CSRF assertion below would pass against a disabled check.
      TEST: '',
    },
    config: demoRouterConfig({
      litellmUrl: 'http://127.0.0.1:1',
      evidenceUrl: 'https://127.0.0.1:1/.well-known/swarm-evidence',
      hostname: 'email-code.e2e.invalid',
    }),
  });
});

afterAll(async () => {
  await router?.stop();
});

function post(path: string, body: unknown, headers: Record<string, string> = { origin: CONSOLE_ORIGIN }) {
  return fetch(`${router.baseUrl}/auth${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    redirect: 'manual',
  });
}

function requestCode(email: string, headers?: Record<string, string>) {
  return post('/email-otp/send-verification-otp', { email, type: 'sign-in' }, headers);
}

/**
 * The newest code mailed to `email`, out of the log. The newest, because asking
 * again replaces the code and the older line is still in the log above it.
 */
async function mailedCode(email: string): Promise<string> {
  const pattern = new RegExp(`Sign-in code for ${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: (\\d{6})`, 'g');
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const found = [...router.log().matchAll(pattern)].at(-1);
    if (found) {
      return found[1];
    }
    await delay(100);
  }
  throw new Error(`No sign-in code for ${email} appeared in the router's log.`);
}

function sessionCookieOf(response: Response): string | null {
  return (response.headers.getSetCookie?.() ?? []).find((entry) => entry.startsWith('cr_session=')) ?? null;
}

async function emailOf(cookie: string): Promise<string | undefined> {
  const me = await fetch(`${router.baseUrl}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookie.split(';')[0], origin: CONSOLE_ORIGIN },
    body: JSON.stringify({ query: '{ me { email workspaces { role } } }' }),
  });
  return ((await me.json()) as { data?: { me: { email: string } } | null }).data?.me.email;
}

describe('email-code sign-in against the built router', () => {
  it('refuses to mail a code for a request from an origin the deployment does not trust', async () => {
    const response = await requestCode('victim@example.test', { origin: 'https://attacker.example' });

    expect(response.status).toBe(403);
    expect(router.log()).not.toContain('Sign-in code for victim@example.test');
  });

  it('mails a code, creates the account with it, and answers with a ninety-day session', async () => {
    expect((await requestCode(EMAIL)).status).toBe(200);

    const response = await post('/sign-in/email-otp', {
      email: EMAIL,
      otp: await mailedCode(EMAIL),
      name: 'New Comer',
    });
    expect(response.status).toBe(200);

    const cookie = sessionCookieOf(response);
    expect(cookie).not.toBeNull();
    sessionTokens.push(decodeURIComponent((cookie as string).split(';')[0].slice('cr_session='.length)));
    // Persistent, so it outlives the browser session, and long.
    expect(Number((cookie as string).match(/Max-Age=(\d+)/i)?.[1])).toBe(SESSION_DAYS * 24 * 3600);
    expect(cookie).toMatch(/HttpOnly/i);

    expect(await emailOf(cookie as string)).toBe(EMAIL);
  });

  it('refuses that code a second time', async () => {
    const response = await post('/sign-in/email-otp', { email: EMAIL, otp: await mailedCode(EMAIL) });

    expect(response.status).toBe(400);
    expect(sessionCookieOf(response)).toBeNull();
  });

  it('refuses a wrong code, and signs the same account in again with a fresh one', async () => {
    expect((await requestCode(EMAIL)).status).toBe(200);
    const code = await mailedCode(EMAIL);

    const wrong = await post('/sign-in/email-otp', { email: EMAIL, otp: code === '000000' ? '111111' : '000000' });
    expect(wrong.status).toBe(400);
    expect(sessionCookieOf(wrong)).toBeNull();

    const right = await post('/sign-in/email-otp', { email: EMAIL, otp: code });
    expect(right.status).toBe(200);
    const cookie = sessionCookieOf(right) as string;
    sessionTokens.push(decodeURIComponent(cookie.split(';')[0].slice('cr_session='.length)));
    expect(await emailOf(cookie)).toBe(EMAIL);
  });

  it('answers the same for an address with an account and one without', async () => {
    const known = await requestCode(EMAIL);
    const unknown = await requestCode('nobody@example.test');

    expect(unknown.status).toBe(known.status);
    expect(await unknown.json()).toEqual(await known.json());
  });

  it('has no password route left', async () => {
    const body = {
      email: EMAIL,
      password: 'process-level-correct-horse',
      name: '',
      newPassword: 'x'.repeat(16),
      token: 't',
    };

    for (const path of ['/sign-up/email', '/sign-in/email', '/request-password-reset', '/reset-password']) {
      expect((await post(path, body)).status, path).toBe(404);
    }
  });

  it('never writes a session token to the log', async () => {
    // The log does carry the codes — that is what the development mailer is —
    // and a code is spent the moment it is used. What it is traded for is not
    // spent, and must not be there.
    await delay(250);

    expect(sessionTokens.length).toBeGreaterThan(0);
    for (const token of sessionTokens) {
      expect(router.log()).not.toContain(token);
      expect(router.log()).not.toContain(token.split('.')[0]);
    }
  });
});
