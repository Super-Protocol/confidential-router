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
const PASSWORD = 'correct-horse-battery';
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
      CR_API_AUTH__PASSWORD__ENABLED: 'true',
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

function signUp(current: Harness) {
  return request(current.app.getHttpServer())
    .post('/auth/sign-up/email')
    .send({ email: EMAIL, password: PASSWORD, name: 'Some One' });
}

describe('an SMTP server the deployment can reach', () => {
  it('is checked at boot and reported as ok', async () => {
    smtp = new FakeSmtpServer({ user: SMTP_USER, password: SMTP_PASSWORD });
    const current = await smtpHarness(await smtp.listen());

    expect((await health(current)).mail).toMatchObject({ provider: 'smtp', state: 'ok' });
  });

  it('receives the welcome mail: authenticated, multipart, with the logo inline', async () => {
    smtp = new FakeSmtpServer({ user: SMTP_USER, password: SMTP_PASSWORD });
    const current = await smtpHarness(await smtp.listen());

    await signUp(current).expect(200);
    const [mail] = await smtp.waitFor(1);

    expect(mail.auth).toBe(`${SMTP_USER}:${SMTP_PASSWORD}`);
    expect(mail.from).toBe('no-reply@example.com');
    expect(mail.to).toEqual([EMAIL]);
    // nodemailer drops the quotes a plain display name does not need.
    expect(mail.data).toMatch(/^From: "?Confidential Router"? <no-reply@example\.com>$/m);
    expect(mail.data).toMatch(/^Subject: Welcome to Confidential Router$/m);
    expect(mail.data).toContain('multipart/alternative');
    expect(mail.data).toMatch(/Content-Type: text\/plain/);
    expect(mail.data).toMatch(/Content-Type: text\/html/);
    expect(mail.data).toMatch(/Content-Type: image\/png/);
    expect(mail.data).toMatch(/Content-ID: <super-protocol-logo>/);
  });

  it('carries a reset link a reader can use', async () => {
    smtp = new FakeSmtpServer({ user: SMTP_USER, password: SMTP_PASSWORD });
    const current = await smtpHarness(await smtp.listen());
    await signUp(current).expect(200);
    await smtp.waitFor(1);

    await request(current.app.getHttpServer()).post('/auth/request-password-reset').send({ email: EMAIL }).expect(200);
    const [, reset] = await smtp.waitFor(2);

    // Quoted-printable may fold the link; unfold before reading it.
    const body = reset.data.replace(/=\r\n/g, '').replace(/=3D/g, '=');
    const token = body.match(/http:\/\/localhost:4200\/reset-password\?token=([A-Za-z0-9_-]+)/)?.[1];
    expect(token).toBeDefined();

    await request(current.app.getHttpServer())
      .post('/auth/reset-password')
      .send({ token, newPassword: 'staple-new-horse-battery' })
      .expect(200);
  });
});

describe('an SMTP server the deployment cannot reach', () => {
  it('is reported unreachable at boot — visibly, not as silence', async () => {
    const current = await smtpHarness(await closedPort());

    expect((await health(current)).mail).toMatchObject({ provider: 'smtp', state: 'failing', reason: 'unreachable' });
  });

  it('still answers the reset request uniformly, and keeps reporting the failure', async () => {
    const current = await smtpHarness(await closedPort());
    await signUp(current).expect(200);

    const known = await request(current.app.getHttpServer())
      .post('/auth/request-password-reset')
      .send({ email: EMAIL })
      .expect(200);
    const unknown = await request(current.app.getHttpServer())
      .post('/auth/request-password-reset')
      .send({ email: 'nobody@example.com' })
      .expect(200);
    await current.settleMail();

    expect(unknown.body).toEqual(known.body);
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
