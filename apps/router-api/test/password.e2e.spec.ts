/**
 * Email and password on a deployment that has no mail delivery at all.
 *
 * Bootstrap gets the first account in; this is how everyone after the first
 * gets in. Every case boots against a harness configured the way the
 * marketplace listing is — `magicLink.mailer: none`, no OAuth app — because a
 * deployment that had either would not be reaching for this path.
 */
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE_NAME } from '../src/app/auth/index.js';
import { createHarness, type Harness } from './app-harness.js';

const EMAIL = 'someone@example.com';
const PASSWORD = 'correct-horse-battery';
const ME_QUERY = '{ me { id email name workspaces { id slug role } } }';
const OPTIONS_QUERY = '{ signInOptions { bootstrap github google magicLink password } }';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

/** A mailer-less deployment with password sign-in switched on. */
async function passwordHarness(env: Record<string, string> = {}): Promise<Harness> {
  harness = await createHarness({
    env: {
      CR_API_AUTH__MAGIC_LINK__MAILER: 'none',
      CR_API_AUTH__PASSWORD__ENABLED: 'true',
      ...env,
    },
  });
  return harness;
}

function signUp(current: Harness, body: Record<string, unknown>) {
  return request(current.app.getHttpServer()).post('/auth/sign-up/email').send(body);
}

function signIn(current: Harness, body: Record<string, unknown>) {
  return request(current.app.getHttpServer()).post('/auth/sign-in/email').send(body);
}

function sessionCookiesOf(response: request.Response): string[] {
  const cookies = response.headers['set-cookie'];
  return (Array.isArray(cookies) ? cookies : [cookies].filter(Boolean)) as string[];
}

function me(current: Harness, cookies: string[]) {
  return request(current.app.getHttpServer()).post('/graphql').set('Cookie', cookies).send({ query: ME_QUERY });
}

async function options(current: Harness) {
  const response = await request(current.app.getHttpServer())
    .post('/graphql')
    .send({ query: OPTIONS_QUERY })
    .expect(200);
  expect(response.body.errors).toBeUndefined();
  return response.body.data.signInOptions;
}

describe('signing up with a password, with no mailer configured', () => {
  it('creates the account, its personal workspace and a session in one request', async () => {
    const current = await passwordHarness();

    const created = await signUp(current, { email: EMAIL, password: PASSWORD, name: 'Some One' }).expect(200);

    // No verification round trip: the session arrives with the sign-up, which
    // is the only way this works on a deployment that cannot send mail.
    const cookies = sessionCookiesOf(created);
    expect(cookies.join(';')).toContain(SESSION_COOKIE_NAME);

    const viewer = await me(current, cookies).expect(200);
    expect(viewer.body.errors).toBeUndefined();
    expect(viewer.body.data.me).toMatchObject({ email: EMAIL, name: 'Some One' });
    // The same `databaseHooks` provisioning every other sign-in path gets.
    expect(viewer.body.data.me.workspaces).toHaveLength(1);
    expect(viewer.body.data.me.workspaces[0]).toMatchObject({ slug: 'someone', role: 'OWNER' });
  });

  it('refuses a second account on the same address', async () => {
    const current = await passwordHarness();
    await signUp(current, { email: EMAIL, password: PASSWORD, name: 'First' }).expect(200);

    const second = await signUp(current, { email: EMAIL, password: 'a-different-password', name: 'Second' });

    expect(second.status).toBeGreaterThanOrEqual(400);
    expect(sessionCookiesOf(second).join(';')).not.toContain(SESSION_COOKIE_NAME);
  });

  it('refuses a password shorter than auth.password.minLength', async () => {
    const current = await passwordHarness({ CR_API_AUTH__PASSWORD__MIN_LENGTH: '16' });

    await signUp(current, { email: EMAIL, password: 'fifteen-chars--', name: 'Too Short' }).expect(400);
    await signUp(current, { email: EMAIL, password: 'sixteen-chars---', name: 'Long Enough' }).expect(200);
  });

  it('never echoes the password back', async () => {
    const current = await passwordHarness();

    const created = await signUp(current, { email: EMAIL, password: PASSWORD, name: 'Some One' }).expect(200);

    expect(JSON.stringify(created.body)).not.toContain(PASSWORD);
    expect(sessionCookiesOf(created).join(';')).not.toContain(PASSWORD);
  });
});

describe('signing in with a password', () => {
  it('returns a session for the right password', async () => {
    const current = await passwordHarness();
    await signUp(current, { email: EMAIL, password: PASSWORD, name: 'Some One' }).expect(200);

    const signedIn = await signIn(current, { email: EMAIL, password: PASSWORD }).expect(200);

    const viewer = await me(current, sessionCookiesOf(signedIn)).expect(200);
    expect(viewer.body.data.me.email).toBe(EMAIL);
  });

  it('refuses a wrong password, and says nothing about which half was wrong', async () => {
    const current = await passwordHarness();
    await signUp(current, { email: EMAIL, password: PASSWORD, name: 'Some One' }).expect(200);

    const wrongPassword = await signIn(current, { email: EMAIL, password: 'not-the-password' }).expect(401);
    const unknownAddress = await signIn(current, { email: 'nobody@example.com', password: PASSWORD }).expect(401);

    expect(sessionCookiesOf(wrongPassword).join(';')).not.toContain(SESSION_COOKIE_NAME);
    expect(wrongPassword.body.message).toBe(unknownAddress.body.message);
  });

  it('signs into the same account a second time rather than provisioning a second workspace', async () => {
    const current = await passwordHarness();
    await signUp(current, { email: EMAIL, password: PASSWORD, name: 'Some One' }).expect(200);

    const again = await signIn(current, { email: EMAIL, password: PASSWORD }).expect(200);

    const viewer = await me(current, sessionCookiesOf(again)).expect(200);
    expect(viewer.body.data.me.workspaces).toHaveLength(1);
  });
});

describe('password reset', () => {
  it('does not exist even where passwords do — it would be a mail round trip', async () => {
    const current = await passwordHarness();
    await signUp(current, { email: EMAIL, password: PASSWORD, name: 'Some One' }).expect(200);

    await request(current.app.getHttpServer())
      .post('/auth/request-password-reset')
      .send({ email: EMAIL, redirectTo: '/' })
      .expect(404);
    await request(current.app.getHttpServer())
      .post('/auth/reset-password')
      .send({ newPassword: 'a-brand-new-password', token: 'anything' })
      .expect(404);
  });
});

describe('a deployment that did not enable passwords', () => {
  it('answers 404 rather than "not enabled" — an unavailable path is not a thing that exists', async () => {
    harness = await createHarness();

    await signUp(harness, { email: EMAIL, password: PASSWORD, name: 'Some One' }).expect(404);
    await signIn(harness, { email: EMAIL, password: PASSWORD }).expect(404);
    await request(harness.app.getHttpServer())
      .post('/auth/change-password')
      .send({ newPassword: PASSWORD, currentPassword: PASSWORD })
      .expect(404);
  });

  it('is the default: nothing has to be set to keep passwords off', async () => {
    harness = await createHarness();

    expect(await options(harness)).toMatchObject({ password: false, magicLink: true });
  });
});

describe('the signInOptions query', () => {
  it('reports the password path so the console can render the forms', async () => {
    const current = await passwordHarness();

    expect(await options(current)).toMatchObject({
      password: true,
      magicLink: false,
      github: false,
      google: false,
    });
  });

  it('still reports it once the deployment has accounts — unlike bootstrap, it does not close', async () => {
    const current = await passwordHarness();
    await signUp(current, { email: EMAIL, password: PASSWORD, name: 'Some One' }).expect(200);

    expect(await options(current)).toMatchObject({ password: true });
  });
});

describe('a mailer-less deployment, end to end', () => {
  it('lets the bootstrapped admin and a self-signed-up user coexist', async () => {
    const token = 'bootstrap-token-32-characters-ok';
    const current = await passwordHarness({
      CR_API_AUTH__BOOTSTRAP_TOKEN: token,
      CR_API_AUTH__BOOTSTRAP_EMAIL: 'admin@example.test',
    });

    const admin = await request(current.app.getHttpServer()).post('/auth/bootstrap').send({ token }).expect(200);
    const user = await signUp(current, { email: EMAIL, password: PASSWORD, name: 'Some One' }).expect(200);

    const adminViewer = await me(current, sessionCookiesOf(admin)).expect(200);
    const userViewer = await me(current, sessionCookiesOf(user)).expect(200);

    expect(adminViewer.body.data.me.email).toBe('admin@example.test');
    expect(userViewer.body.data.me.email).toBe(EMAIL);
    // Separate accounts, separate workspaces: nothing about signing up second
    // attaches you to the deployment owner's workspace.
    expect(adminViewer.body.data.me.workspaces[0].id).not.toBe(userViewer.body.data.me.workspaces[0].id);
  });

  it('closes the bootstrap window once anyone has signed up with a password', async () => {
    const token = 'bootstrap-token-32-characters-ok';
    const current = await passwordHarness({ CR_API_AUTH__BOOTSTRAP_TOKEN: token });
    await signUp(current, { email: EMAIL, password: PASSWORD, name: 'Some One' }).expect(200);

    // The gate is "this deployment has an owner", whichever path produced them.
    await request(current.app.getHttpServer()).post('/auth/bootstrap').send({ token }).expect(404);
    expect(await options(current)).toMatchObject({ bootstrap: false, password: true });
  });
});
