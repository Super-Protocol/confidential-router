/**
 * Real SMTP, end to end (SUP-269).
 *
 * The application keeps its configured transport — nodemailer, over a socket —
 * and talks to an SMTP server this suite runs on loopback. That covers what
 * the capturing harness cannot: that a message actually leaves the process in
 * a shape a mail server accepts, with the credentials it was given, and that
 * a server which cannot be reached is *reported* rather than silently eating
 * the mail — the first failure mode the issue names for an egress-restricted
 * deployment.
 */
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { MailService } from '../src/app/mail/index.js';
import { createHarness, type Harness } from './app-harness.js';
import { closedPort, FakeSmtpServer } from './fake-smtp.js';

const EMAIL = 'someone@example.com';
const SMTP_USER = 'mailer@example.com';
const SMTP_PASSWORD = 'throwaway-smtp-password';
/** For the invite-only case: the one account that exists without an invitation. */
const BOOTSTRAP_TOKEN = 'bootstrap-token-'.padEnd(40, 'x');
const ADMIN = 'admin@example.com';

let harness: Harness | undefined;
let smtp: FakeSmtpServer | undefined;

afterEach(async () => {
  await harness?.close();
  await smtp?.close();
  harness = undefined;
  smtp = undefined;
});

async function smtpHarness(port: number, env: Record<string, string> = {}): Promise<Harness> {
  harness = await createHarness({
    realMailTransport: true,
    env: {
      CR_API_MAIL__PROVIDER: 'smtp',
      CR_API_MAIL__FROM: 'no-reply@example.com',
      CR_API_MAIL__SMTP__HOST: '127.0.0.1',
      CR_API_MAIL__SMTP__PORT: String(port),
      CR_API_MAIL__SMTP__SECURITY: 'none',
      CR_API_MAIL__SMTP__USER: SMTP_USER,
      CR_API_MAIL__SMTP__PASSWORD: SMTP_PASSWORD,
      CR_API_MAIL__SMTP__CONNECT_TIMEOUT: '2s',
      ...env,
    },
  });
  // `onApplicationBootstrap` started the boot-time check; let it finish.
  await harness.app.get(MailService).settle();
  return harness;
}

async function health(current: Harness) {
  return (await request(current.app.getHttpServer()).get('/health').expect(200)).body;
}

function requestCode(current: Harness, email = EMAIL) {
  return request(current.app.getHttpServer())
    .post('/auth/email-otp/send-verification-otp')
    .send({ email, type: 'sign-in' });
}

/** The six digits in a delivered sign-in mail, read from the plain-text part a person would read. */
function codeIn(data: string): string {
  const code = data.match(/^(\d{6})\r?$/m)?.[1];
  if (!code) {
    throw new Error('The delivered mail carries no six-digit code on a line of its own.');
  }
  return code;
}

describe('an SMTP server the deployment can reach', () => {
  it('is checked at boot and reported as ok', async () => {
    smtp = new FakeSmtpServer({ user: SMTP_USER, password: SMTP_PASSWORD });
    const current = await smtpHarness(await smtp.listen());

    expect((await health(current)).mail).toMatchObject({ provider: 'smtp', state: 'ok' });
  });

  it('delivers a sign-in code that signs the reader in, then the welcome mail — authenticated and multipart', async () => {
    smtp = new FakeSmtpServer({ user: SMTP_USER, password: SMTP_PASSWORD });
    const current = await smtpHarness(await smtp.listen());

    await requestCode(current).expect(200);
    const [codeMail] = await smtp.waitFor(1);
    expect(codeMail.auth).toBe(`${SMTP_USER}:${SMTP_PASSWORD}`);
    expect(codeMail.to).toEqual([EMAIL]);
    expect(codeMail.data).toMatch(/^Subject: Your Confidential Router sign-in code$/m);

    // The code as it came off the wire, not out of a capturing double.
    await request(current.app.getHttpServer())
      .post('/auth/sign-in/email-otp')
      .send({ email: EMAIL, otp: codeIn(codeMail.data), name: 'Some One' })
      .expect(200);

    const [, welcome] = await smtp.waitFor(2);
    expect(welcome.from).toBe('no-reply@example.com');
    // nodemailer drops the quotes a plain display name does not need.
    expect(welcome.data).toMatch(/^From: "?Confidential Router"? <no-reply@example\.com>$/m);
    expect(welcome.data).toMatch(/^Subject: Welcome to Confidential Router$/m);
    expect(welcome.data).toContain('multipart/alternative');
    expect(welcome.data).toMatch(/Content-Type: text\/plain/);
    expect(welcome.data).toMatch(/Content-Type: text\/html/);
    expect(welcome.data).toMatch(/Content-Type: image\/png/);
    expect(welcome.data).toMatch(/Content-ID: <super-protocol-logo>/);
  });
});

describe('an SMTP server the deployment cannot reach', () => {
  it('is reported unreachable at boot — visibly, not as silence', async () => {
    const current = await smtpHarness(await closedPort());

    expect((await health(current)).mail).toMatchObject({ provider: 'smtp', state: 'failing', reason: 'unreachable' });
  });

  /**
   * SUP-460. Better Auth catches and logs whatever the send callback rejects
   * with and returns its own `{"success": true}` anyway, so a code the mailer
   * could not get out used to read as a code that went out. On a deployment
   * where sign-in is by emailed code only — which is what production runs —
   * that is every account locked out while the router reports success, and
   * nobody finds out until a user complains. The after hook in
   * `mail-send-failure.plugin.ts` is what turns it back into a refusal.
   */
  it('refuses a code request it could not send, under one name', async () => {
    const current = await smtpHarness(await closedPort());

    const refused = await requestCode(current);

    expect(refused.status).toBe(503);
    expect(refused.body).toEqual({ code: 'MAIL_SEND_FAILED', message: expect.any(String) });
    // Not a word about the host it could not reach, or the account it tried.
    expect(JSON.stringify(refused.body)).not.toContain('127.0.0.1');
    expect((await health(current)).mail).toMatchObject({ state: 'failing', reason: 'unreachable' });
  });

  it('refuses it the same way for every address on an open deployment', async () => {
    const current = await smtpHarness(await closedPort());

    const known = await requestCode(current, EMAIL);
    const unknown = await requestCode(current, 'nobody@example.com');

    // The transport is down for everybody, so the refusal says nothing about
    // who asked — which is the property the 200 used to carry and this has to
    // keep.
    expect(unknown.status).toBe(known.status);
    expect(unknown.body).toEqual(known.body);
    expect(Object.keys(unknown.headers).sort()).toEqual(Object.keys(known.headers).sort());
  });

  /**
   * The send that was never attempted is answered like the ones that were.
   * `MailService` stays silent for a recipient past its hourly allowance, and
   * the gate below stays silent for an uninvited address — but neither may be
   * *visible* as silence, so the refusal is read off the mailer's state rather
   * than off whether this request reached `deliver`.
   */
  it('refuses a recipient past its allowance the same way', async () => {
    const current = await smtpHarness(await closedPort(), {
      CR_API_AUTH__EMAIL_CODE__MAILS_PER_ADDRESS_PER_HOUR: '1',
    });

    await requestCode(current).expect(503);
    await requestCode(current).expect(503);
  });

  /**
   * The shape production runs, and the one the uniformity claim is worth
   * anything on. `#131`'s gate returns before the send for an address with no
   * account and no invitation (SUP-410), so that request never fails — and if
   * the refusal were a function of *this request* rather than of the mailer, an
   * account holder would get a 503 here while a stranger got a 200. That
   * differential is unauthenticated account enumeration, available exactly
   * while the mailer is down, and it is the property `#131` was written to buy.
   */
  it('refuses an uninvited address and an account holder alike on an invite-only deployment', async () => {
    const current = await smtpHarness(await closedPort(), {
      CR_API_AUTH__REQUIRE_INVITE_FOR_SIGN_UP: 'true',
      CR_API_AUTH__BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN,
      CR_API_AUTH__BOOTSTRAP_EMAIL: ADMIN,
    });
    // The bootstrap account is the one address the gate admits with no
    // invitation anywhere near the request.
    await request(current.app.getHttpServer()).post('/auth/bootstrap').send({ token: BOOTSTRAP_TOKEN }).expect(200);

    const account = await requestCode(current, ADMIN);
    const uninvited = await requestCode(current, 'stranger@example.com');

    expect(account.status).toBe(503);
    expect(uninvited.status).toBe(account.status);
    expect(uninvited.body).toEqual(account.body);
    expect(Object.keys(uninvited.headers).sort()).toEqual(Object.keys(account.headers).sort());
  });

  /**
   * The edge of the outage, where deciding on the way *out* of the request
   * would still have leaked. The state says `failing` and the transport works
   * again — the moment an outage ends, or any time after one transient send
   * failure. Only an address the gate admits reaches a send, so only that
   * address can heal the state; reading the state after the handler would have
   * answered it 200 by its own repair while a withheld address still got 503.
   * Read on arrival, both are refused.
   *
   * The probes run withheld-first on purpose: that is the state an attacker
   * finds, and the order in which no send has yet healed anything. A *second*
   * probe after an admitted send does still differ — see the residual noted on
   * SUP-460; it is not closed by the capture and is not pinned here.
   */
  it('refuses both alike on the first probe into a stale-failing window', async () => {
    const port = await closedPort();
    const current = await smtpHarness(port, {
      CR_API_AUTH__REQUIRE_INVITE_FOR_SIGN_UP: 'true',
      CR_API_AUTH__BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN,
      CR_API_AUTH__BOOTSTRAP_EMAIL: ADMIN,
    });
    await request(current.app.getHttpServer()).post('/auth/bootstrap').send({ token: BOOTSTRAP_TOKEN }).expect(200);
    // The welcome mail that sign-up started is fire-and-forget; let it finish
    // failing, or it lands after the server below comes up and heals the state.
    await current.settleMail();
    expect((await health(current)).mail).toMatchObject({ state: 'failing' });
    // The transport comes back underneath a deployment that still says it is down.
    smtp = new FakeSmtpServer();
    await smtp.listen(port);

    const uninvited = await requestCode(current, 'stranger@example.com');
    const account = await requestCode(current, ADMIN);

    expect(uninvited.status).toBe(503);
    expect(account.status).toBe(uninvited.status);
    expect(account.body).toEqual(uninvited.body);

    // The account's mail did go out — that is the one cost of reading on
    // arrival: a 503 for a code that is in the inbox and still works. The state
    // it healed is what makes the retry a 200.
    expect((await smtp.waitFor(1))[0].to).toEqual([ADMIN]);
    expect((await health(current)).mail).toMatchObject({ state: 'ok' });
    await requestCode(current, ADMIN).expect(200);
  });

  it('refuses a magic link it could not send the same way', async () => {
    const current = await smtpHarness(await closedPort());

    const refused = await request(current.app.getHttpServer())
      .post('/auth/sign-in/magic-link')
      .send({ email: EMAIL, callbackURL: '/' });

    expect(refused.status).toBe(503);
    expect(refused.body).toMatchObject({ code: 'MAIL_SEND_FAILED' });
  });

  it('reports refused credentials as such', async () => {
    smtp = new FakeSmtpServer({ user: SMTP_USER, password: 'something-else' });
    const current = await smtpHarness(await smtp.listen());

    expect((await health(current)).mail).toMatchObject({ state: 'failing', reason: 'auth_failed' });
  });

  it('never puts the SMTP password in the health report', async () => {
    const current = await smtpHarness(await closedPort());

    expect(JSON.stringify(await health(current))).not.toContain(SMTP_PASSWORD);
  });
});
