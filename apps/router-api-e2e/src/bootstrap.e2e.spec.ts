/**
 * First sign-in against the built artefact, on a genuinely empty deployment.
 *
 * `apps/router-api/test/bootstrap.e2e.spec.ts` covers the behaviour; two things
 * only a real process can show are here. The token must not reach the log — the
 * one place a deployment secret is most likely to leak from, and one this suite
 * can read the way an operator reads `docker compose logs api`. And Better Auth
 * disables its own origin check inside a test runner, so the CSRF guard on this
 * endpoint is only observable from a process that is not one.
 *
 * The stack is `startRouterProcess`, not `startRouterStack`: the latter signs a
 * user in as part of coming up, which is precisely the state that closes this
 * endpoint.
 *
 * **Four requests reach `/auth/bootstrap` below, and the plugin's own rate limit
 * is five a minute.** Better Auth only enables rate limiting in production and
 * this process runs as `development`, so nothing is throttled today — but a
 * fifth case, or a run against a production-mode build, would start answering
 * 429 and the failure would look nothing like a rate limit. Add cases to the
 * in-process suite instead, or raise the window here deliberately.
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

const TOKEN = 'process-level-bootstrap-token-64';
const BOOTSTRAP_EMAIL = 'admin@example.test';

let router: RouterProcess;

beforeAll(async () => {
  const port = await freePort();
  router = await startRouterProcess({
    port,
    env: {
      CR_API_SERVER__PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
      CR_API_AUTH__BASE_URL: `http://127.0.0.1:${port}`,
      CR_API_AUTH__BOOTSTRAP_TOKEN: TOKEN,
      CR_API_AUTH__BOOTSTRAP_EMAIL: BOOTSTRAP_EMAIL,
      // A marketplace deployment has neither, and this is the configuration
      // under which the endpoint is the only way in.
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
      hostname: 'bootstrap.e2e.invalid',
    }),
  });
});

afterAll(async () => {
  await router?.stop();
});

function bootstrap(token: string, headers: Record<string, string> = {}) {
  return fetch(`${router.baseUrl}/auth/bootstrap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ token }),
    redirect: 'manual',
  });
}

function sessionCookieOf(response: Response): string | null {
  const cookie = (response.headers.getSetCookie?.() ?? [])
    .map((entry) => entry.split(';')[0])
    .find((entry) => entry.startsWith('cr_session='));
  return cookie ?? null;
}

describe('bootstrap against the built router', () => {
  it('refuses a request from an origin the deployment does not trust', async () => {
    const response = await bootstrap(TOKEN, { origin: 'https://attacker.example' });

    expect(response.status).toBe(403);
  });

  it('refuses a wrong token, and says which kind of "no" that is', async () => {
    const response = await bootstrap('not-the-configured-token', { origin: CONSOLE_ORIGIN });

    expect(response.status).toBe(401);
    expect(sessionCookieOf(response)).toBeNull();
  });

  it('trades the token for the first account and a usable session', async () => {
    const response = await bootstrap(TOKEN, { origin: CONSOLE_ORIGIN });
    expect(response.status).toBe(200);

    const cookie = sessionCookieOf(response);
    expect(cookie).not.toBeNull();

    const me = await fetch(`${router.baseUrl}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookie as string, origin: CONSOLE_ORIGIN },
      body: JSON.stringify({ query: '{ me { email workspaces { slug role } } }' }),
    });
    const body = (await me.json()) as { data?: { me: { email: string; workspaces: { role: string }[] } } };

    expect(body.data?.me.email).toBe(BOOTSTRAP_EMAIL);
    expect(body.data?.me.workspaces[0]?.role).toBe('OWNER');
  });

  it('closes for good once that account exists', async () => {
    const response = await bootstrap(TOKEN, { origin: CONSOLE_ORIGIN });

    expect(response.status).toBe(404);
  });

  it('never writes the token to the log', async () => {
    // Everything above has already been through the process: a valid bootstrap,
    // a rejected one and a blocked origin — all three paths that see the token.
    // Give the logger a moment to flush what the last request produced.
    await delay(250);

    expect(router.log()).not.toContain(TOKEN);
    // The response body is not the place for it either, and nothing else on
    // the box should be echoing it.
    expect(router.log()).not.toContain(TOKEN.slice(0, 12));
  });
});
