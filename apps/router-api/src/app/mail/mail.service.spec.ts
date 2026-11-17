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
    ['EENVELOPE', 'rejected'],
    ['EWHATEVER', 'error'],
  ])('maps %s to %s', (code, reason) => {
    expect(failureReasonOf(errorWithCode('x', code))).toBe(reason);
  });

  it('sees through a fetch TypeError to the connect failure under it', () => {
    expect(failureReasonOf(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }))).toBe(
      'unreachable',
    );
  });
});
