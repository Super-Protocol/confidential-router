/**
 * The one state in which the deployment's own token does nothing: users exist,
 * and the account the token belongs to is not among them (SUP-269).
 *
 * A process of its own, because the state is the opposite of the one
 * `bootstrap.e2e.spec.ts` builds: there the token's account is the first thing
 * created, and here somebody else's is. That takes a mailer — the stranger gets
 * in with a code — which that suite deliberately does not have.
 */
import {
  CONSOLE_ORIGIN,
  demoRouterConfig,
  freePort,
  type RouterProcess,
  startRouterProcess,
} from '@confidential-router/demo';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TOKEN = 'process-level-bootstrap-token-64';
const SOMEONE_ELSE = 'someone-else@example.test';

let router: RouterProcess;

beforeAll(async () => {
  const port = await freePort();
  router = await startRouterProcess({
    port,
    env: {
      CR_API_SERVER__PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
      CR_API_AUTH__BASE_URL: `http://127.0.0.1:${port}`,
      CR_API_AUTH__BOOTSTRAP_TOKEN: TOKEN,
      CR_API_AUTH__BOOTSTRAP_EMAIL: 'admin@example.test',
      // The development mailer: codes are written to this process's log.
      CR_API_MAIL__PROVIDER: 'console',
      TEST: '',
    },
    config: demoRouterConfig({
      litellmUrl: 'http://127.0.0.1:1',
      evidenceUrl: 'https://127.0.0.1:1/.well-known/swarm-evidence',
      hostname: 'bootstrap-missing.e2e.invalid',
    }),
  });
});

afterAll(async () => {
  await router?.stop();
});

function post(path: string, body: unknown) {
  return fetch(`${router.baseUrl}/auth${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: CONSOLE_ORIGIN },
    body: JSON.stringify(body),
    redirect: 'manual',
  });
}

describe('the bootstrap token on a deployment claimed by somebody else', () => {
  it('is a 404 — right token or wrong — because there is no account for it to open', async () => {
    expect((await post('/email-otp/send-verification-otp', { email: SOMEONE_ELSE, type: 'sign-in' })).status).toBe(200);
    const [, code] = await router.waitForLog(
      new RegExp(`Sign-in code for ${SOMEONE_ELSE.replace(/\./g, '\\.')}: (\\d{6})`),
    );
    expect((await post('/sign-in/email-otp', { email: SOMEONE_ELSE, otp: code })).status).toBe(200);

    const right = await post('/bootstrap', { token: TOKEN });
    const wrong = await post('/bootstrap', { token: 'not-the-configured-token' });

    // It creates nothing after the first account, and it does not say whether
    // the token was the right one.
    expect(right.status).toBe(404);
    expect(wrong.status).toBe(404);
    expect(right.headers.getSetCookie?.() ?? []).toEqual([]);
    expect(router.log()).not.toContain('Break-glass sign-in');
  });
});
