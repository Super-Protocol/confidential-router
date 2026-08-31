import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SESSION_COOKIE_NAME } from '../src/app/auth/index.js';
import { createHarness, type Harness, pathOf } from './app-harness.js';

const EMAIL = 'developer@example.com';
const ME_QUERY = '{ me { id email name workspaces { id slug role balanceMicros } } }';

let harness: Harness;

beforeAll(async () => {
  harness = await createHarness();
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

function server() {
  return harness.app.getHttpServer();
}

/** Full magic-link sign-in; returns the `Set-Cookie` values a browser would keep. */
async function signIn(email: string): Promise<string[]> {
  await request(server())
    .post('/auth/sign-in/magic-link')
    .send({ email, callbackURL: '/' })
    .expect((response) => {
      expect(response.status).toBeLessThan(400);
    });

  const verify = await request(server()).get(pathOf(harness.mailer.last.url));
  expect(verify.status).toBeLessThan(400);

  const cookies = verify.headers['set-cookie'];
  return Array.isArray(cookies) ? cookies : [cookies].filter(Boolean);
}

describe('magic-link sign-in', () => {
  it('mails a link, and following it starts a session', async () => {
    const cookies = await signIn(EMAIL);

    expect(harness.mailer.sent).toHaveLength(1);
    expect(harness.mailer.last.email).toBe(EMAIL);
    expect(cookies.join(';')).toContain(SESSION_COOKIE_NAME);
  });

  it('marks the session cookie HttpOnly and SameSite=Lax', async () => {
    const cookies = await signIn('cookie-check@example.com');
    const sessionCookie = cookies.find((cookie) => cookie.startsWith(`${SESSION_COOKIE_NAME}=`));

    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).toContain('HttpOnly');
    expect(sessionCookie).toMatch(/SameSite=Lax/i);
  });

  it('refuses a token that has already been used', async () => {
    await request(server()).post('/auth/sign-in/magic-link').send({ email: 'replay@example.com', callbackURL: '/' });
    const url = pathOf(harness.mailer.last.url);

    const first = await request(server()).get(url);
    expect(first.status).toBeLessThan(400);

    const replay = await request(server()).get(url);
    const replayCookies: string[] = ([] as string[]).concat(replay.headers['set-cookie'] ?? []);
    expect(replayCookies.some((cookie) => cookie.startsWith(`${SESSION_COOKIE_NAME}=`))).toBe(false);
  });
});

describe('the me query', () => {
  it('is refused without a session', async () => {
    const response = await request(server()).post('/graphql').send({ query: ME_QUERY }).expect(200);

    expect(response.body.data).toBeNull();
    expect(response.body.errors?.[0]?.message).toContain('Authentication is required');
  });

  it('is refused with a bogus session cookie', async () => {
    const response = await request(server())
      .post('/graphql')
      .set('Cookie', `${SESSION_COOKIE_NAME}=not-a-real-session`)
      .send({ query: ME_QUERY })
      .expect(200);

    expect(response.body.errors?.[0]?.message).toContain('Authentication is required');
  });

  it('returns the signed-in user and the personal workspace provisioned on first login', async () => {
    const cookies = await signIn('viewer@example.com');

    const response = await request(server())
      .post('/graphql')
      .set('Cookie', cookies)
      .send({ query: ME_QUERY })
      .expect(200);

    expect(response.body.errors).toBeUndefined();
    expect(response.body.data.me).toMatchObject({ email: 'viewer@example.com' });
    expect(response.body.data.me.workspaces).toHaveLength(1);
    expect(response.body.data.me.workspaces[0]).toMatchObject({
      slug: 'viewer',
      role: 'OWNER',
      balanceMicros: '0',
    });
  });

  it('does not provision a second workspace when the same user signs in again', async () => {
    const email = 'returning@example.com';
    await signIn(email);
    const cookies = await signIn(email);

    const response = await request(server()).post('/graphql').set('Cookie', cookies).send({ query: ME_QUERY });

    expect(response.body.data.me.workspaces).toHaveLength(1);
  });

  it('gives two users separate workspaces', async () => {
    // Sequential on purpose: the capturing mailer holds one link at a time.
    const firstCookies = await signIn('a@example.com');
    const secondCookies = await signIn('b@example.com');

    const first = await request(server()).post('/graphql').set('Cookie', firstCookies).send({ query: ME_QUERY });
    const second = await request(server()).post('/graphql').set('Cookie', secondCookies).send({ query: ME_QUERY });

    expect(first.body.data.me.workspaces[0].id).not.toBe(second.body.data.me.workspaces[0].id);
    expect(first.body.data.me.workspaces[0].slug).toBe('a');
    expect(second.body.data.me.workspaces[0].slug).toBe('b');
  });
});
