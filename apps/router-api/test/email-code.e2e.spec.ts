/**
 * Sign-in by a code mailed to the address, and the welcome mail (SUP-269).
 *
 * There are no passwords: this is how an account signs in and how one is
 * created. Every case boots the real application; only the hop out of the
 * process is replaced (`CapturingMailer`), so Better Auth's codes, the
 * throttles and the decision whether to send at all are the production code.
 * The suite that speaks real SMTP is `mail-smtp.e2e.spec.ts`.
 */
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE_NAME } from '../src/app/auth/index.js';
import { createHarness, type Harness, lastCodeFor, signInWithCode } from './app-harness.js';

const EMAIL = 'someone@example.com';
const ME_QUERY = '{ me { id email name workspaces { slug role } } }';
const OPTIONS_QUERY =
  '{ signInOptions { emailCode emailCodeLength magicLink bootstrap adminRecovery inviteRequired } }';
const CONSOLE = 'http://localhost:4200';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

/** A deployment with a mailer — the marketplace listing with SMTP set. */
async function codeHarness(env: Record<string, string> = {}): Promise<Harness> {
  harness = await createHarness({ env: { CR_API_MAIL__PROVIDER: 'console', ...env } });
  return harness;
}

function server(current: Harness) {
  return current.app.getHttpServer();
}

function cookiesOf(response: request.Response): string[] {
  const cookies = response.headers['set-cookie'];
  return (Array.isArray(cookies) ? cookies : [cookies].filter(Boolean)) as string[];
}

function requestCode(current: Harness, email: string, inviteCode?: string) {
  return request(server(current))
    .post('/auth/email-otp/send-verification-otp')
    .send({ email, type: 'sign-in', ...(inviteCode ? { inviteCode } : {}) });
}

/** The send route with whatever body a caller felt like posting. */
function send(current: Harness, body: Record<string, unknown>) {
  return request(server(current)).post('/auth/email-otp/send-verification-otp').send(body);
}

function signIn(current: Harness, email: string, otp: string) {
  return request(server(current)).post('/auth/sign-in/email-otp').send({ email, otp });
}

async function me(current: Harness, cookies: string[]) {
  const response = await request(server(current)).post('/graphql').set('Cookie', cookies).send({ query: ME_QUERY });
  return response.body;
}

async function options(current: Harness) {
  const response = await request(server(current)).post('/graphql').send({ query: OPTIONS_QUERY }).expect(200);
  expect(response.body.errors).toBeUndefined();
  return response.body.data.signInOptions;
}

/** A six-digit code that is certainly not `code`. */
function wrong(code: string): string {
  return code === '000000' ? '111111' : '000000';
}

describe('signing in with an emailed code', () => {
  it('is what the sign-in screen is told to offer', async () => {
    await expect(options(await codeHarness())).resolves.toMatchObject({ emailCode: true, emailCodeLength: 6 });
  });

  it('mails a six-digit code, creates the account with it, and answers with a session', async () => {
    const current = await codeHarness();

    await requestCode(current, EMAIL).expect(200);
    const mail = current.mailer.ofKind('sign-in-code').at(-1);
    expect(mail).toMatchObject({ to: EMAIL, subject: 'Your Confidential Router sign-in code' });
    expect(mail?.code).toMatch(/^\d{6}$/);
    // In the body, both parts — and not in the subject a lock screen shows.
    expect(mail?.text).toContain(mail?.code);
    expect(mail?.html).toContain(mail?.code);
    expect(mail?.subject).not.toContain(mail?.code);

    const signedIn = await request(server(current))
      .post('/auth/sign-in/email-otp')
      .send({ email: EMAIL, otp: lastCodeFor(current, EMAIL), name: 'Some One' })
      .expect(200);
    const cookies = cookiesOf(signedIn);
    expect(cookies.join(';')).toContain(SESSION_COOKIE_NAME);

    const viewer = await me(current, cookies);
    expect(viewer.errors).toBeUndefined();
    expect(viewer.data.me).toMatchObject({ email: EMAIL, name: 'Some One' });
    // The same `databaseHooks` provisioning every other sign-in path gets.
    expect(viewer.data.me.workspaces).toEqual([{ slug: 'someone', role: 'OWNER' }]);
  });

  it('signs an existing account in again, into the same account', async () => {
    const current = await codeHarness();
    const first = await me(current, cookiesOf(await signInWithCode(current, EMAIL)));

    const again = await signInWithCode(current, EMAIL.toUpperCase());
    expect(again.status).toBe(200);
    const second = await me(current, cookiesOf(again));

    expect(second.data.me.id).toBe(first.data.me.id);
  });

  it('accepts a code once', async () => {
    const current = await codeHarness();
    await requestCode(current, EMAIL).expect(200);
    const code = lastCodeFor(current, EMAIL);

    await signIn(current, EMAIL, code).expect(200);
    const replay = await signIn(current, EMAIL, code);

    expect(replay.status).toBe(400);
    expect(cookiesOf(replay).join(';')).not.toContain(`${SESSION_COOKIE_NAME}=`);
  });

  it('refuses an expired code', async () => {
    const current = await codeHarness({ CR_API_AUTH__EMAIL_CODE__TTL: '1s' });
    await requestCode(current, EMAIL).expect(200);
    const code = lastCodeFor(current, EMAIL);

    await new Promise((resolve) => setTimeout(resolve, 1500));

    const expired = await signIn(current, EMAIL, code);
    expect(expired.status).toBe(400);
    expect(expired.body.code).toBe('OTP_EXPIRED');
  });

  it('refuses a wrong code, and voids the right one after too many wrong guesses', async () => {
    const current = await codeHarness({ CR_API_AUTH__EMAIL_CODE__ATTEMPTS: '2' });
    await requestCode(current, EMAIL).expect(200);
    const code = lastCodeFor(current, EMAIL);

    expect((await signIn(current, EMAIL, wrong(code)).expect(400)).body.code).toBe('INVALID_OTP');
    expect((await signIn(current, EMAIL, wrong(code)).expect(400)).body.code).toBe('INVALID_OTP');

    // Guessing is over: even the real code is refused now.
    const afterwards = await signIn(current, EMAIL, code);
    expect(afterwards.status).toBeGreaterThanOrEqual(400);
    expect(cookiesOf(afterwards).join(';')).not.toContain(`${SESSION_COOKIE_NAME}=`);
  });

  it('replaces the code when another is asked for: only the newest works', async () => {
    const current = await codeHarness();
    await requestCode(current, EMAIL).expect(200);
    const first = lastCodeFor(current, EMAIL);
    await requestCode(current, EMAIL).expect(200);
    const second = lastCodeFor(current, EMAIL);

    if (first !== second) {
      await signIn(current, EMAIL, first).expect(400);
    }
    await signIn(current, EMAIL, second).expect(200);
  });

  it('answers a request identically whether or not the address has an account', async () => {
    const current = await codeHarness();
    await signInWithCode(current, EMAIL);

    const known = await requestCode(current, EMAIL).expect(200);
    const unknown = await requestCode(current, 'nobody@example.com').expect(200);

    expect(unknown.body).toEqual(known.body);
    expect(Object.keys(unknown.headers).sort()).toEqual(Object.keys(known.headers).sort());
  });

  it('rate-limits asking for codes per source address, for known and unknown addresses alike', async () => {
    const current = await codeHarness({ CR_API_AUTH__EMAIL_CODE__REQUESTS_PER_MINUTE: '2' });

    await requestCode(current, EMAIL).expect(200);
    await requestCode(current, 'nobody@example.com').expect(200);
    const refused = await requestCode(current, EMAIL).expect(429);

    expect(refused.body).toEqual({ code: 'RATE_LIMITED', message: expect.any(String) });
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    expect((await requestCode(current, 'nobody@example.com').expect(429)).body).toEqual(refused.body);
  });

  it('rate-limits trying codes per source address, on a budget of its own', async () => {
    const current = await codeHarness({ CR_API_AUTH__EMAIL_CODE__REQUESTS_PER_MINUTE: '2' });
    await requestCode(current, EMAIL).expect(200);

    await signIn(current, EMAIL, '000000');
    await signIn(current, EMAIL, '000001');
    await signIn(current, EMAIL, '000002').expect(429);
  });

  it('mails one recipient at most its hourly allowance, without answering any differently', async () => {
    const current = await codeHarness({ CR_API_AUTH__EMAIL_CODE__MAILS_PER_ADDRESS_PER_HOUR: '1' });

    const first = await requestCode(current, EMAIL).expect(200);
    const second = await requestCode(current, EMAIL).expect(200);

    expect(second.body).toEqual(first.body);
    expect(current.mailer.ofKind('sign-in-code')).toHaveLength(1);
  });

  it('mails nothing for the code types this deployment does not use', async () => {
    const current = await codeHarness();
    await signInWithCode(current, EMAIL);
    const before = current.mailer.messages.length;

    for (const type of ['forget-password', 'email-verification']) {
      await request(server(current)).post('/auth/email-otp/send-verification-otp').send({ email: EMAIL, type });
    }
    await current.settleMail();

    expect(current.mailer.messages.slice(before).filter((message) => message.kind === 'sign-in-code')).toEqual([]);
  });
});

describe('sessions', () => {
  it('last ninety days by default, as a persistent cookie that survives closing the browser', async () => {
    const current = await codeHarness();
    const cookie = cookiesOf(await signInWithCode(current, EMAIL)).find((value) =>
      value.startsWith(`${SESSION_COOKIE_NAME}=`),
    );

    // `Max-Age` is what makes it outlive the browser session.
    expect(Number(cookie?.match(/Max-Age=(\d+)/i)?.[1])).toBe(90 * 24 * 3600);
    expect(cookie).toMatch(/HttpOnly/i);
  });

  it('take their length from auth.sessionMaxAge', async () => {
    const current = await codeHarness({ CR_API_AUTH__SESSION_MAX_AGE: '24h' });
    const cookie = cookiesOf(await signInWithCode(current, EMAIL)).join(';');

    expect(Number(cookie.match(/Max-Age=(\d+)/i)?.[1])).toBe(24 * 3600);
  });

  it('keep working on later requests, and end at sign-out', async () => {
    const current = await codeHarness();
    const cookies = cookiesOf(await signInWithCode(current, EMAIL)).map((value) => value.split(';')[0]);

    expect((await me(current, cookies)).data.me.email).toBe(EMAIL);
    expect((await me(current, cookies)).data.me.email).toBe(EMAIL);

    await request(server(current)).post('/auth/sign-out').set('Cookie', cookies).send({}).expect(200);
    expect((await me(current, cookies)).data).toBeNull();
  });
});

describe('an invite-only deployment', () => {
  const BOOTSTRAP_TOKEN = 'bootstrap-token-'.padEnd(40, 'x');
  const ADMIN = 'admin@example.com';
  const ISSUE = `mutation ($input: IssueInviteCodesInput!) { issueInviteCodes(input: $input) { codes { code } } }`;

  const DELIVERY =
    '{ mailDelivery { state inviteOnly withheld { noInvitation rateLimited unusedCodeType lastWithheldAt } } }';

  async function inviteOnly(): Promise<{ current: Harness; code: string; admin: string[] }> {
    const current = await codeHarness({
      CR_API_AUTH__REQUIRE_INVITE_FOR_SIGN_UP: 'true',
      CR_API_AUTH__BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN,
      CR_API_AUTH__BOOTSTRAP_EMAIL: ADMIN,
      CR_API_AUTH__ADMIN_EMAILS: ADMIN,
    });
    const admin = await request(server(current)).post('/auth/bootstrap').send({ token: BOOTSTRAP_TOKEN }).expect(200);
    const issued = await request(server(current))
      .post('/graphql')
      .set('Cookie', cookiesOf(admin))
      .send({ query: ISSUE, variables: { input: { campaign: 'e2e', count: 1, grantMicros: '100000000' } } });
    expect(issued.body.errors).toBeUndefined();
    return { current, code: issued.body.data.issueInviteCodes.codes[0].code, admin: cookiesOf(admin) };
  }

  /** `mailDelivery`, as the operator reads it: `SessionGuard` + `AdminGuard`. */
  async function delivery(current: Harness, cookies: string[]) {
    const response = await request(server(current)).post('/graphql').set('Cookie', cookies).send({ query: DELIVERY });
    expect(response.body.errors).toBeUndefined();
    return response.body.data.mailDelivery;
  }

  it('creates an account for an unknown address with an invitation and the emailed code, in one flow', async () => {
    const { current, code } = await inviteOnly();

    const created = await signInWithCode(current, EMAIL, { inviteCode: code });

    expect(created.status).toBe(200);
    expect((await me(current, cookiesOf(created))).data.me.email).toBe(EMAIL);
  });

  /**
   * The hole SUP-410 closed. The account gate held — nothing was created — but
   * the request *before* it mailed a sign-in code to any address a stranger
   * named, which made the deployment's verified sender an open relay for
   * whoever found the hostname.
   */
  it('mails nothing to an unknown address with no invitation', async () => {
    const { current } = await inviteOnly();

    await requestCode(current, EMAIL).expect(200);
    await current.settleMail();

    expect(current.mailer.ofKind('sign-in-code').filter((mail) => mail.to === EMAIL)).toEqual([]);
  });

  it('mails nothing for an invitation it would refuse either', async () => {
    const { current, code } = await inviteOnly();
    // Spent: the one seat goes to the first account, and the code is worth
    // nothing to whoever holds it afterwards.
    await signInWithCode(current, 'first@example.com', { inviteCode: code });

    await requestCode(current, EMAIL, code).expect(200);
    await requestCode(current, 'other@example.com', 'ZZZZ-ZZZZ-ZZZZ').expect(200);
    await current.settleMail();

    expect(current.mailer.ofKind('sign-in-code').map((mail) => mail.to)).toEqual(['first@example.com']);
  });

  /**
   * The gate is asked where the credential would leave the process, so no body
   * shape routes around it and none of them changes what the route answers
   * (CTO review on #131). Both halves matter: an uninvited stranger is mailed
   * nothing whatever `type` says, and the answer never depends on whether the
   * address has an account — which it would if a hook in front of the route
   * answered some of these itself.
   */
  it('mails nothing for any body shape, and answers each one as the route always did', async () => {
    const { current, code } = await inviteOnly();
    // EMAIL has an account from here on; the other address has none.
    await signInWithCode(current, EMAIL, { inviteCode: code });
    const mailed = current.mailer.ofKind('sign-in-code').length;
    const shapes: Record<string, unknown>[] = [
      {},
      { type: 'sign-in' },
      { type: 'email-verification' },
      { type: 'forget-password' },
      { type: 'change-email' },
      { type: 'not-a-type' },
    ];

    for (const shape of shapes) {
      const known = await send(current, { email: EMAIL, ...shape });
      const unknown = await send(current, { email: 'uninvited@example.com', ...shape });

      expect(unknown.status, JSON.stringify(shape)).toBe(known.status);
      expect(unknown.body, JSON.stringify(shape)).toEqual(known.body);
    }
    await current.settleMail();

    // The account got its codes — `sign-in` is the one type that mails — and the
    // uninvited address got nothing at all.
    expect(current.mailer.ofKind('sign-in-code').length).toBeGreaterThan(mailed);
    expect(current.mailer.ofKind('sign-in-code').filter((mail) => mail.to === 'uninvited@example.com')).toEqual([]);
  });

  it('answers a withheld request exactly as it answers one it sent', async () => {
    const { current, code } = await inviteOnly();

    const sent = await requestCode(current, EMAIL, code).expect(200);
    const withheld = await requestCode(current, 'uninvited@example.com').expect(200);

    expect(withheld.status).toBe(sent.status);
    // Byte for byte, not merely deep-equal: the constraint SUP-462 had to keep
    // is that the response does not change at all, and a reader comparing two
    // of these has the text, not the parse.
    expect(withheld.text).toBe(sent.text);
    expect(withheld.body).toEqual(sent.body);
    expect(Object.keys(withheld.headers).sort()).toEqual(Object.keys(sent.headers).sort());
  });

  /**
   * SUP-462. The gate's silence towards the caller is correct and untouched;
   * its silence towards the deployment's own operator was not, and produced a
   * false production incident — five `200 {"success":true}` with nothing
   * reaching the mail provider, read as "production has stopped sending".
   */
  it('tells the operator a withheld send from a working transport, counted by reason', async () => {
    const { current, code, admin } = await inviteOnly();

    expect(await delivery(current, admin)).toMatchObject({ inviteOnly: true, withheld: null });

    await requestCode(current, EMAIL, code).expect(200);
    await current.settleMail();
    const afterSend = await delivery(current, admin);

    for (const address of ['a@example.com', 'b@example.com', 'c@example.com']) {
      await requestCode(current, address).expect(200);
    }
    await current.settleMail();
    const afterWithheld = await delivery(current, admin);

    // Sent: the transport worked and nothing was withheld.
    expect(afterSend).toMatchObject({ state: 'OK', withheld: null });
    // Withheld: the transport is *still* fine — which is the distinction the
    // operator had no way to make, and the reason SUP-460 was filed as urgent.
    expect(afterWithheld).toMatchObject({
      state: 'OK',
      withheld: { noInvitation: 3, rateLimited: 0, unusedCodeType: 0 },
    });
    expect(Date.parse(afterWithheld.withheld.lastWithheldAt)).not.toBeNaN();
  });

  /**
   * The second silent early return in the same callback (CTO review on this
   * change): the route accepts three code `type`s and this deployment mails
   * one, so a client asking for either of the others also gets a `200` and no
   * mail — the same blind spot, one line further down.
   */
  it('counts a code type this deployment does not mail, separately from an uninvited address', async () => {
    const { current, code, admin } = await inviteOnly();
    await signInWithCode(current, EMAIL, { inviteCode: code });

    await send(current, { email: EMAIL, type: 'forget-password' });
    await current.settleMail();

    expect((await delivery(current, admin)).withheld).toMatchObject({ noInvitation: 0, unusedCodeType: 1 });
  });

  it('keeps the withheld count off the public surfaces that would make it an oracle', async () => {
    const { current, admin } = await inviteOnly();
    await requestCode(current, 'uninvited@example.com').expect(200);
    await current.settleMail();

    const health = await request(server(current)).get('/health').expect(200);
    const anonymous = await request(server(current)).post('/graphql').send({ query: DELIVERY });

    // `/health` says the gate is on — the one line that stops the misread —
    // and says nothing that moves when an address is named. A count a stranger
    // could read before and after posting one would tell them by subtraction
    // whether it was mailed, which is the account-existence oracle SUP-410
    // exists to deny.
    expect(health.body.mail).toMatchObject({ signUpGate: 'invite_only' });
    expect(JSON.stringify(health.body)).not.toContain('withheld');
    expect(anonymous.body.data?.mailDelivery ?? null).toBeNull();
    expect(anonymous.body.errors).toBeDefined();
    // And the operator can still read it.
    expect((await delivery(current, admin)).withheld).toMatchObject({ noInvitation: 1 });
  });

  it('refuses the operator surface to a signed-in member who is not an admin', async () => {
    const { current, code, admin } = await inviteOnly();
    const member = await signInWithCode(current, EMAIL, { inviteCode: code });

    const response = await request(server(current))
      .post('/graphql')
      .set('Cookie', cookiesOf(member))
      .send({ query: DELIVERY });

    expect(response.body.data?.mailDelivery ?? null).toBeNull();
    expect(response.body.errors).toBeDefined();
    expect((await delivery(current, admin)).inviteOnly).toBe(true);
  });

  it('mails an existing account its code with no invitation anywhere near the request', async () => {
    const { current, code } = await inviteOnly();
    await signInWithCode(current, EMAIL, { inviteCode: code });

    const again = await signInWithCode(current, EMAIL);

    expect(again.status).toBe(200);
  });

  /**
   * The one window the mail gate leaves, and the only way the typed refusal
   * still reaches this path: both codes were mailed while the invitation was
   * usable, and the second sign-up arrives after the first has taken its only
   * seat.
   */
  it('does not let one invitation create two accounts', async () => {
    const { current, code } = await inviteOnly();
    await requestCode(current, EMAIL, code).expect(200);
    await requestCode(current, 'other@example.com', code).expect(200);
    const second = lastCodeFor(current, 'other@example.com');

    await request(server(current))
      .post('/auth/sign-in/email-otp')
      .send({ email: EMAIL, otp: lastCodeFor(current, EMAIL), inviteCode: code })
      .expect(200);
    const refused = await request(server(current))
      .post('/auth/sign-in/email-otp')
      .send({ email: 'other@example.com', otp: second, inviteCode: code });

    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('invite_already_claimed');
    expect(cookiesOf(refused).join(';')).not.toContain(`${SESSION_COOKIE_NAME}=`);
  });

  it('refuses the sign-up when the code it carries is not the one the mail was asked for with', async () => {
    const { current, code } = await inviteOnly();
    await requestCode(current, EMAIL, code).expect(200);
    const mailed = lastCodeFor(current, EMAIL);

    const refused = await request(server(current))
      .post('/auth/sign-in/email-otp')
      .send({ email: EMAIL, otp: mailed, inviteCode: 'ZZZZ-ZZZZ-ZZZZ' });

    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('invite_expired_or_unknown');
  });
});

describe('a deployment with no mailer', () => {
  async function mailless(env: Record<string, string> = {}): Promise<Harness> {
    harness = await createHarness({ env: { CR_API_AUTH__MAGIC_LINK__MAILER: 'none', ...env } });
    return harness;
  }

  it('offers no code and mounts no code routes: it is bootstrap-token-only', async () => {
    const current = await mailless();

    await expect(options(current)).resolves.toMatchObject({ emailCode: false, magicLink: false });
    await requestCode(current, EMAIL).expect(404);
    await signIn(current, EMAIL, '000000').expect(404);
  });
});

describe('passwords', () => {
  it('are gone: every password route is a 404, with or without the deprecated config key', async () => {
    harness = await createHarness({
      env: { CR_API_MAIL__PROVIDER: 'console', CR_API_AUTH__PASSWORD__ENABLED: 'true' },
    });
    const body = { email: EMAIL, password: 'correct-horse-battery', name: '', newPassword: 'x'.repeat(16), token: 't' };

    for (const path of [
      '/auth/sign-up/email',
      '/auth/sign-in/email',
      '/auth/change-password',
      '/auth/request-password-reset',
      '/auth/reset-password',
      '/auth/email-otp/request-password-reset',
      '/auth/forget-password/email-otp',
      '/auth/email-otp/reset-password',
      '/auth/email-otp/request-email-change',
      '/auth/email-otp/change-email',
    ]) {
      await request(server(harness)).post(path).send(body).expect(404);
    }
  });
});

describe('the welcome mail', () => {
  it('greets a new account with the console URL and the credit it was granted', async () => {
    const current = await codeHarness({ CR_API_BILLING__SIGNUP_GRANT_MICROS: '20000000' });
    await signInWithCode(current, EMAIL, { name: 'Some One' });
    await current.settleMail();

    const [welcome] = current.mailer.ofKind('welcome');
    expect(welcome).toMatchObject({ to: EMAIL, subject: 'Welcome to Confidential Router', link: CONSOLE });
    expect(welcome.text).toContain(`Console: ${CONSOLE}`);
    expect(welcome.text).toContain('Starting credit: $20');
    expect(welcome.html).toContain('Welcome, Some One');
  });

  it('is sent once per account, not on every sign-in', async () => {
    const current = await codeHarness();
    await signInWithCode(current, EMAIL);
    await signInWithCode(current, EMAIL);
    await signInWithCode(current, EMAIL);
    await current.settleMail();

    expect(current.mailer.ofKind('welcome')).toHaveLength(1);
  });
});
