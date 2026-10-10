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

  it('answers a code request the same for every address, and keeps reporting the failure', async () => {
    const current = await smtpHarness(await closedPort());

    const first = await requestCode(current, EMAIL);
    const second = await requestCode(current, 'nobody@example.com');

    // Better Auth swallows a failed send, so the requester is told nothing —
    // the same nothing for an account and for a stranger. Where it shows is
    // here, and in the log.
    expect(first.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect((await health(current)).mail).toMatchObject({ state: 'failing', reason: 'unreachable' });
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
