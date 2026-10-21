import { Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RouterConfigSchema, type routerConfig } from '../config.js';
import { failureReasonOf, MailService } from './mail.service.js';
import type { MailMessage, MailTransport } from './mail-transport.js';

const SMTP_PASSWORD = 'smtp-password-that-must-not-leak';

class FakeTransport implements MailTransport {
  readonly provider = 'smtp' as const;
  readonly sent: MailMessage[] = [];
  sendError?: Error;
  verifyError?: Error;

  async send(message: MailMessage): Promise<void> {
    if (this.sendError) {
      throw this.sendError;
    }
    this.sent.push(message);
  }

  async verify(): Promise<void> {
    if (this.verifyError) {
      throw this.verifyError;
    }
  }
}

function errorWithCode(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

/**
 * What nodemailer throws when every recipient was refused: `EENVELOPE` *and* a
 * `rejected` list naming them (`smtp-connection/index.js`, `_actionRCPT`). The
 * list is the whole discriminator — the refusals that are not about the
 * recipient carry the same code without it.
 */
function refusedRecipient(address: string): Error {
  return Object.assign(new Error("Can't send mail - all recipients were rejected: 550 5.1.1 No such user here"), {
    code: 'EENVELOPE',
    rejected: [address],
  });
}

function build(overrides: { mail?: object; auth?: object } = {}) {
  const config = RouterConfigSchema.parse({
    server: { validClientOrigins: ['https://console.example.com'] },
    auth: { secret: 's'.repeat(32), ...overrides.auth },
    mail: {
      provider: 'smtp',
      from: 'no-reply@example.com',
      smtp: { host: 'smtp.example.com', user: 'mailer', password: SMTP_PASSWORD },
      ...overrides.mail,
    },
  }) as ConfigType<typeof routerConfig>;
  const transport = new FakeTransport();
  return { service: new MailService(config, transport), transport };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MailService', () => {
  it('awaits a magic link and hands its failure to the requester', async () => {
    const { service, transport } = build();
    transport.sendError = errorWithCode('connect ECONNREFUSED', 'ESOCKET');
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await expect(service.sendMagicLink('a@example.com', 'https://x/verify')).rejects.toThrow('ECONNREFUSED');
    expect(service.status()).toMatchObject({ state: 'failing', reason: 'unreachable' });
  });

  it('mails a sign-in code: in the body, out of the subject, and with no link to click', async () => {
    const { service, transport } = build();

    await service.sendSignInCode('a@example.com', '482913');

    expect(transport.sent).toHaveLength(1);
    const [mail] = transport.sent;
    expect(mail).toMatchObject({ to: 'a@example.com', kind: 'sign-in-code', code: '482913' });
    expect(mail.link).toBeUndefined();
    expect(mail.text).toContain('482913');
    expect(mail.html).toContain('482913');
    expect(mail.subject).not.toContain('482913');
    expect(mail.html).not.toContain('<a ');
  });

  it('awaits a sign-in code and hands its failure to the requester', async () => {
    const { service, transport } = build();
    transport.sendError = errorWithCode('Invalid login: 535', 'EAUTH');
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await expect(service.sendSignInCode('a@example.com', '482913')).rejects.toThrow('Invalid login');
    expect(service.status()).toMatchObject({ state: 'failing', reason: 'auth_failed' });
  });

  it('never throws from a welcome, whatever the provider does', async () => {
    const { service, transport } = build();
    transport.sendError = errorWithCode('Invalid login: 535', 'EAUTH');
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    expect(() => service.sendWelcome({ email: 'b@example.com', startingCreditMicros: 0 })).not.toThrow();
    await service.settle();

    expect(service.status()).toMatchObject({ state: 'failing', reason: 'auth_failed' });
  });

  it('mails one recipient no more codes per hour than configured, and resolves all the same', async () => {
    const { service, transport } = build({ auth: { emailCode: { mailsPerAddressPerHour: 2 } } });
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    for (let i = 0; i < 4; i += 1) {
      await expect(service.sendSignInCode('A@example.com', `00000${i}`)).resolves.toBeUndefined();
    }
    await service.sendSignInCode('other@example.com', '111111');

    expect(transport.sent.map((message) => message.to)).toEqual([
      'A@example.com',
      'A@example.com',
      'other@example.com',
    ]);
  });

  it('welcomes a new account with the credit it was granted', async () => {
    const { service, transport } = build();

    service.sendWelcome({ email: 'a@example.com', name: 'Ada', startingCreditMicros: 20_000_000 });
    await service.settle();

    expect(transport.sent[0]).toMatchObject({
      to: 'a@example.com',
      kind: 'welcome',
      link: 'https://console.example.com',
    });
    expect(transport.sent[0].text).toContain('Starting credit: $20');
  });

  it('skips the welcome for an undeliverable .local address and on a mailer-less deployment', async () => {
    const withMail = build();
    withMail.service.sendWelcome({ email: 'admin@confidential-router.local', startingCreditMicros: 0 });
    await withMail.service.settle();
    expect(withMail.transport.sent).toEqual([]);

    const without = build({ mail: { provider: 'none', smtp: undefined } });
    without.service.sendWelcome({ email: 'a@example.com', startingCreditMicros: 0 });
    await without.service.settle();
    expect(without.transport.sent).toEqual([]);
    expect(without.service.status()).toEqual({ provider: 'none', state: 'disabled' });
  });

  /**
   * A recipient the server will not take is the address the caller named, not
   * the mailer going down — and the difference is load bearing twice.
   * `mail-send-failure.plugin.ts` answers the send route from this state, so a
   * state anyone could set by getting one send attempted would be a refusal
   * anyone could induce; and answering the caller differently from a send this
   * deployment withheld is the same account-existence differential in
   * miniature.
   */
  it('resolves and leaves the deployment reported as it was when a recipient was refused', async () => {
    const { service, transport } = build();
    transport.sendError = refusedRecipient('nobody@example.com');

    await expect(service.sendSignInCode('nobody@example.com', '482913')).resolves.toBeUndefined();

    expect(service.status()).toMatchObject({ state: 'unverified' });
    expect(service.status().reason).toBeUndefined();
  });

  it('leaves an established state alone when a recipient is refused', async () => {
    const { service, transport } = build();
    await service.sendSignInCode('someone@example.com', '482913');
    expect(service.status().state).toBe('ok');

    transport.sendError = refusedRecipient('nobody@example.com');
    await expect(service.sendSignInCode('nobody@example.com', '482913')).resolves.toBeUndefined();

    expect(service.status()).toMatchObject({ state: 'ok' });
  });

  /**
   * The refusal that looks like a refused recipient and is the opposite of it:
   * a relay that will not carry our sender answers at the same SMTP stage with
   * the same code and no `rejected` list, and can send nothing for anybody.
   */
  it('reports the deployment failing when the envelope was refused without naming a recipient', async () => {
    const { service, transport } = build();
    transport.sendError = errorWithCode('Mail command failed: 550 sender not verified', 'EENVELOPE');

    await expect(service.sendSignInCode('someone@example.com', '482913')).rejects.toThrow(/sender not verified/);

    expect(service.status()).toMatchObject({ state: 'failing', reason: 'error' });
  });

  it.each([
    ['ECONNECTION', 'unreachable'],
    ['EAUTH', 'auth_failed'],
    ['EMESSAGE', 'error'],
    ['EWHATEVER', 'error'],
  ])('still reports the deployment failing for %s', async (code, reason) => {
    const { service, transport } = build();
    transport.sendError = errorWithCode('x', code);

    await expect(service.sendSignInCode('someone@example.com', '482913')).rejects.toThrow();

    expect(service.status()).toMatchObject({ state: 'failing', reason });
  });

  describe('the boot-time check', () => {
    it('reports ok when the SMTP server accepts the connection and credentials', async () => {
      const { service } = build();
      vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

      expect(service.status().state).toBe('unverified');
      service.onApplicationBootstrap();
      await service.settle();

      expect(service.status()).toMatchObject({ provider: 'smtp', state: 'ok' });
    });

    it('reports an unreachable server visibly, and says what to check — never silently', async () => {
      const { service, transport } = build();
      transport.verifyError = errorWithCode('Connection timeout', 'ETIMEDOUT');
      const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      service.onApplicationBootstrap();
      await service.settle();

      expect(service.status()).toMatchObject({ state: 'failing', reason: 'unreachable' });
      const line = String(error.mock.calls[0][0]);
      expect(line).toContain('smtp.example.com:587');
      expect(line).toMatch(/could not be reached from this deployment/);
      expect(line).toMatch(/private address/);
    });

    it('never writes the SMTP password to the log', async () => {
      const { service, transport } = build();
      transport.verifyError = errorWithCode('Invalid login: 535 5.7.8 Authentication failed', 'EAUTH');
      const calls: unknown[][] = [];
      for (const level of ['log', 'error', 'warn', 'debug', 'verbose'] as const) {
        vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
          calls.push(args);
        });
      }

      service.onApplicationBootstrap();
      await service.settle();
      service.sendWelcome({ email: 'a@example.com', startingCreditMicros: 0 });
      await service.settle();

      expect(calls.length).toBeGreaterThan(0);
      expect(JSON.stringify(calls)).not.toContain(SMTP_PASSWORD);
      expect(JSON.stringify(service.status())).not.toContain(SMTP_PASSWORD);
    });
  });
});

describe('failureReasonOf', () => {
  it.each([
    ['ECONNECTION', 'unreachable'],
    ['ETIMEDOUT', 'unreachable'],
    ['ESOCKET', 'unreachable'],
    ['EDNS', 'unreachable'],
    ['EAUTH', 'auth_failed'],
    // Without a `rejected` list these are the sender, the body or an API
    // misuse — every one of them the mailer rather than the address.
    ['EENVELOPE', 'error'],
    ['EMESSAGE', 'error'],
    ['EWHATEVER', 'error'],
  ])('maps %s to %s', (code, reason) => {
    expect(failureReasonOf(errorWithCode('x', code))).toBe(reason);
  });

  it('reads the recipient list, not the code, to find a refused recipient', () => {
    expect(failureReasonOf(refusedRecipient('nobody@example.com'))).toBe('recipient_refused');
    expect(failureReasonOf(Object.assign(new Error('x'), { code: 'EENVELOPE', rejected: [] }))).toBe('error');
  });

  it('sees through a fetch TypeError to the connect failure under it', () => {
    expect(failureReasonOf(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }))).toBe(
      'unreachable',
    );
  });
});
