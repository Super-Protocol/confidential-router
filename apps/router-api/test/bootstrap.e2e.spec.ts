/**
 * First sign-in on a deployment that has no other way in.
 *
 * Every case here boots its own application against an empty SQLite file,
 * because the whole feature is defined by the state of the `user` table and a
 * suite that shared one would only be able to test the first assertion.
 */
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE_NAME } from '../src/app/auth/index.js';
import { createHarness, type Harness, pathOf, signIn } from './app-harness.js';

const TOKEN = 'bootstrap-token-32-characters-ok';
const BOOTSTRAP_EMAIL = 'admin@example.test';
const ME_QUERY = '{ me { id email workspaces { id slug role } } }';
const OPTIONS_QUERY = '{ signInOptions { bootstrap github google magicLink } }';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

/** A deployment configured the way a marketplace install is: token, no mailer. */
async function marketplaceHarness(env: Record<string, string> = {}): Promise<Harness> {
  harness = await createHarness({
    env: {
      CR_API_AUTH__BOOTSTRAP_TOKEN: TOKEN,
      CR_API_AUTH__BOOTSTRAP_EMAIL: BOOTSTRAP_EMAIL,
      ...env,
    },
  });
  return harness;
}

function bootstrap(current: Harness, token: string) {
  return request(current.app.getHttpServer()).post('/auth/bootstrap').send({ token });
}

function sessionCookiesOf(response: request.Response): string[] {
  const cookies = response.headers['set-cookie'];
  return (Array.isArray(cookies) ? cookies : [cookies].filter(Boolean)) as string[];
}

describe('POST /auth/bootstrap, on an empty deployment', () => {
  it('creates the first account, its workspace and a session', async () => {
    const current = await marketplaceHarness();

    const created = await bootstrap(current, TOKEN).expect(200);
    const cookies = sessionCookiesOf(created);
    expect(cookies.join(';')).toContain(SESSION_COOKIE_NAME);

    const me = await request(current.app.getHttpServer())
      .post('/graphql')
      .set('Cookie', cookies)
      .send({ query: ME_QUERY })
      .expect(200);

    expect(me.body.errors).toBeUndefined();
    expect(me.body.data.me.email).toBe(BOOTSTRAP_EMAIL);
    // The same personal-workspace provisioning every other first sign-in gets,
    // because it runs from Better Auth's user-created hook either way.
    expect(me.body.data.me.workspaces).toHaveLength(1);
    expect(me.body.data.me.workspaces[0]).toMatchObject({ slug: 'admin', role: 'OWNER' });
  });

  it('never echoes the token back', async () => {
    const current = await marketplaceHarness();

    const created = await bootstrap(current, TOKEN).expect(200);

    expect(JSON.stringify(created.body)).not.toContain(TOKEN);
    expect(sessionCookiesOf(created).join(';')).not.toContain(TOKEN);
  });

  it('creates an account exactly once — afterwards it can only sign back into that one', async () => {
    const current = await marketplaceHarness();
    const first = await bootstrap(current, TOKEN).expect(200);

    // Break-glass (SUP-269): the same token, the same account, a new session.
    const again = await bootstrap(current, TOKEN).expect(200);
    expect(again.body.user).toEqual(first.body.user);
    expect(sessionCookiesOf(again).join(';')).toContain('cr_session=');

    const users = await request(current.app.getHttpServer())
      .post('/graphql')
      .set('Cookie', sessionCookiesOf(again))
      .send({ query: '{ me { email } }' });
    expect(users.body.data.me.email).toBe(BOOTSTRAP_EMAIL);
  });

  it('answers 401 for a wrong token after the claim too, and opens nothing', async () => {
    const current = await marketplaceHarness();
    await bootstrap(current, TOKEN).expect(200);

    const refused = await bootstrap(current, 'some-other-token-entirely').expect(401);
    expect(sessionCookiesOf(refused).join(';')).not.toContain('cr_session=');
  });

  it('lets the administrator back in when the mailer is down, and nobody else', async () => {
    // A deployment whose codes cannot be delivered: the administrator's session
    // is gone, and the token is the only credential that needs no inbox.
    const current = await marketplaceHarness({ CR_API_AUTH__MAGIC_LINK__MAILER: 'none' });
    const claimed = await bootstrap(current, TOKEN).expect(200);
    await request(current.app.getHttpServer())
      .post('/auth/sign-out')
      .set('Cookie', sessionCookiesOf(claimed))
      .send({})
      .expect(200);

    const back = await bootstrap(current, TOKEN).expect(200);

    expect(back.body.user.email).toBe(BOOTSTRAP_EMAIL);
    const options = await request(current.app.getHttpServer())
      .post('/graphql')
      .send({ query: '{ signInOptions { bootstrap adminRecovery emailCode } }' });
    expect(options.body.data.signInOptions).toEqual({ bootstrap: false, adminRecovery: true, emailCode: false });
  });

  it('is a 404 once the deployment has users and none of them is the bootstrap account', async () => {
    // The token never creates a second account and never opens somebody else's:
    // with users present and its own address not among them, it can do nothing.
    const current = await marketplaceHarness({ CR_API_AUTH__MAGIC_LINK__MAILER: 'console' });
    await signIn(current, 'someone-else@example.com');

    await bootstrap(current, TOKEN).expect(404);
  });

  it('answers 401 for a wrong token, so a typo is not a dead end', async () => {
    const current = await marketplaceHarness();

    await bootstrap(current, 'not-the-configured-token').expect(401);
    await bootstrap(current, '').expect(401);
    // And having answered 401, it is still open to the right token.
    await bootstrap(current, TOKEN).expect(200);
  });

  // The origin check that guards this endpoint is Better Auth's, and Better
  // Auth switches it off under `NODE_ENV=test` — so it is asserted against a
  // real process in `apps/router-api-e2e/src/bootstrap.e2e.spec.ts` instead.
});

describe('POST /auth/bootstrap, when it is not configured', () => {
  it('does not exist at all', async () => {
    harness = await createHarness();

    // Not 401 and not 403: with no token configured the plugin is never
    // registered, so Better Auth's own router has nothing to route to.
    await bootstrap(harness, TOKEN).expect(404);
    await bootstrap(harness, '').expect(404);
  });
});

describe('the signInOptions query', () => {
  async function options(current: Harness) {
    const response = await request(current.app.getHttpServer())
      .post('/graphql')
      .send({ query: OPTIONS_QUERY })
      .expect(200);
    expect(response.body.errors).toBeUndefined();
    return response.body.data.signInOptions;
  }

  it('is public — the viewer asking has no session by definition', async () => {
    harness = await createHarness();

    await expect(options(harness)).resolves.toMatchObject({ bootstrap: false, magicLink: true });
  });

  it('offers bootstrap while the deployment is empty, and stops the moment it is not', async () => {
    const current = await marketplaceHarness();

    expect(await options(current)).toMatchObject({ bootstrap: true, github: false, google: false });

    await bootstrap(current, TOKEN).expect(200);

    expect(await options(current)).toMatchObject({ bootstrap: false });
  });

  it('reports the mailer being switched off, so the console can hide the form', async () => {
    const current = await marketplaceHarness({ CR_API_AUTH__MAGIC_LINK__MAILER: 'none' });

    expect(await options(current)).toMatchObject({ bootstrap: true, magicLink: false });
  });

  it('never reports the token itself', async () => {
    const current = await marketplaceHarness();

    const response = await request(current.app.getHttpServer()).post('/graphql').send({ query: OPTIONS_QUERY });

    expect(JSON.stringify(response.body)).not.toContain(TOKEN);
  });
});

describe('a deployment with no mailer', () => {
  it('leaves magic-link sign-in unmounted rather than failing halfway through it', async () => {
    const current = await marketplaceHarness({ CR_API_AUTH__MAGIC_LINK__MAILER: 'none' });

    await request(current.app.getHttpServer())
      .post('/auth/sign-in/magic-link')
      .send({ email: 'someone@example.com', callbackURL: '/' })
      .expect(404);
  });

  it('still lets the bootstrapped admin use the console', async () => {
    const current = await marketplaceHarness({ CR_API_AUTH__MAGIC_LINK__MAILER: 'none' });
    const cookies = sessionCookiesOf(await bootstrap(current, TOKEN).expect(200));

    const models = await request(current.app.getHttpServer())
      .post('/graphql')
      .set('Cookie', cookies)
      .send({ query: '{ me { email } models { id } }' })
      .expect(200);

    expect(models.body.errors).toBeUndefined();
    expect(models.body.data.me.email).toBe(BOOTSTRAP_EMAIL);
  });
});

describe('the bootstrapped account afterwards', () => {
  it('is the same account a magic link to that address signs into', async () => {
    // The address is the deployment's, so an operator who later configures a
    // mailer for it lands back in the account they already own, rather than
    // stranding it behind a token that no longer works.
    const current = await marketplaceHarness();
    const bootstrapped = sessionCookiesOf(await bootstrap(current, TOKEN).expect(200));

    const idOf = async (cookies: string[]) =>
      (await request(current.app.getHttpServer()).post('/graphql').set('Cookie', cookies).send({ query: ME_QUERY }))
        .body.data.me.id;

    await request(current.app.getHttpServer())
      .post('/auth/sign-in/magic-link')
      .send({ email: BOOTSTRAP_EMAIL, callbackURL: '/' });
    const verify = await request(current.app.getHttpServer()).get(pathOf(current.mailer.last.url));

    expect(await idOf(sessionCookiesOf(verify))).toBe(await idOf(bootstrapped));
  });
});
