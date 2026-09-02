/**
 * Email and password against the built artefact, on a deployment configured the
 * way a marketplace install is: no mailer, no OAuth app, passwords on.
 *
 * `apps/router-api/test/password.e2e.spec.ts` covers the behaviour. Two things
 * only a real process can show are here. A password must not reach the log —
 * the one place a credential is most likely to leak from, and one this suite can
 * read the way an operator reads `docker compose logs api`. And Better Auth
 * disables its own origin check inside a test runner, so the CSRF guard on
 * sign-up is only observable from a process that is not one.
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
const PASSWORD = 'process-level-correct-horse-battery';

let router: RouterProcess;

beforeAll(async () => {
  const port = await freePort();
  router = await startRouterProcess({
    port,
    env: {
      CR_API_SERVER__PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
      CR_API_AUTH__BASE_URL: `http://127.0.0.1:${port}`,
      CR_API_AUTH__PASSWORD__ENABLED: 'true',
      // A marketplace deployment has neither, and this is the configuration
      // under which passwords are the only self-service way in.
      CR_API_AUTH__MAGIC_LINK__MAILER: 'none',
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
      hostname: 'password.e2e.invalid',
    }),
  });
});

afterAll(async () => {
  await router?.stop();
});

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${router.baseUrl}/auth${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    redirect: 'manual',
  });
}

function sessionCookieOf(response: Response): string | null {
  return (
    (response.headers.getSetCookie?.() ?? [])
      .map((entry) => entry.split(';')[0])
      .find((entry) => entry.startsWith('cr_session=')) ?? null
  );
}

describe('password sign-up against the built router', () => {
  it('refuses a sign-up from an origin the deployment does not trust', async () => {
    const response = await post(
      '/sign-up/email',
      { email: 'attacker@example.test', password: PASSWORD, name: '' },
      { origin: 'https://attacker.example' },
    );

    expect(response.status).toBe(403);
  });

  it('creates the account and a usable session, with no mailer anywhere', async () => {
    const response = await post(
      '/sign-up/email',
      { email: EMAIL, password: PASSWORD, name: 'New Comer' },
      { origin: CONSOLE_ORIGIN },
    );
    expect(response.status).toBe(200);

    const cookie = sessionCookieOf(response);
    expect(cookie).not.toBeNull();

    const me = await fetch(`${router.baseUrl}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookie as string, origin: CONSOLE_ORIGIN },
      body: JSON.stringify({ query: '{ me { email workspaces { slug role } } }' }),
    });
    const body = (await me.json()) as { data?: { me: { email: string; workspaces: { role: string }[] } } };

    expect(body.data?.me.email).toBe(EMAIL);
    expect(body.data?.me.workspaces[0]?.role).toBe('OWNER');
  });

  it('refuses a second account on the same address', async () => {
    const response = await post(
      '/sign-up/email',
      { email: EMAIL, password: 'a-different-password-entirely', name: '' },
      { origin: CONSOLE_ORIGIN },
    );

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(sessionCookieOf(response)).toBeNull();
  });

  it('signs the account in afterwards, and refuses the wrong password', async () => {
    const wrong = await post(
      '/sign-in/email',
      { email: EMAIL, password: 'not-the-password' },
      { origin: CONSOLE_ORIGIN },
    );
    expect(wrong.status).toBe(401);
    expect(sessionCookieOf(wrong)).toBeNull();

    const right = await post('/sign-in/email', { email: EMAIL, password: PASSWORD }, { origin: CONSOLE_ORIGIN });
    expect(right.status).toBe(200);
    expect(sessionCookieOf(right)).not.toBeNull();
  });

  it('never writes a password to the log', async () => {
    // Every path that sees one has already been through the process: a
    // successful sign-up, a rejected duplicate, a wrong sign-in and a blocked
    // origin. Give the logger a moment to flush the last of it.
    await delay(250);

    expect(router.log()).not.toContain(PASSWORD);
    expect(router.log()).not.toContain(PASSWORD.slice(0, 16));
  });
});
