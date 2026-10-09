import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MailSettings } from './mail-settings.js';
import {
  ConsoleMailTransport,
  createMailTransport,
  DisabledMailTransport,
  formatSender,
  type MailMessage,
  ResendMailTransport,
  SmtpMailTransport,
  smtpTransportOptions,
} from './mail-transport.js';

const BASE: MailSettings = {
  provider: 'console',
  from: 'no-reply@example.com',
  fromName: 'Confidential Router',
  consoleUrl: 'https://console.example.com',
};

const MESSAGE: MailMessage = {
  to: 'someone@example.com',
  subject: 'Subject',
  html: '<p>hi</p>',
  text: 'hi',
  kind: 'welcome',
  inlineImages: [{ contentId: 'logo', filename: 'logo.png', contentType: 'image/png', content: 'aGk=' }],
};

const SMTP = { host: 'smtp.example.com', port: 587, security: 'starttls' as const, connectTimeoutMs: 10_000 };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('createMailTransport', () => {
  it('refuses the console transport in production — links in a log are links anyone with log access can use', () => {
    expect(() => createMailTransport(BASE, 'production')).toThrow(/"console" in production/);
    expect(createMailTransport(BASE, 'development')).toBeInstanceOf(ConsoleMailTransport);
  });

  it('refuses Resend without a key and SMTP without a host', () => {
    expect(() => createMailTransport({ ...BASE, provider: 'resend' })).toThrow(/Resend API key/);
    expect(() => createMailTransport({ ...BASE, provider: 'smtp' })).toThrow(/mail\.smtp\.host/);
  });

  it('builds each provider', () => {
    expect(createMailTransport({ ...BASE, provider: 'none' })).toBeInstanceOf(DisabledMailTransport);
    expect(createMailTransport({ ...BASE, provider: 'resend', resendApiKey: 'k' })).toBeInstanceOf(ResendMailTransport);
    expect(createMailTransport({ ...BASE, provider: 'smtp', smtp: SMTP }, 'production')).toBeInstanceOf(
      SmtpMailTransport,
    );
  });

  it('logs a magic link in the line tools/demo reads it from', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    await new ConsoleMailTransport().send({ ...MESSAGE, kind: 'magic-link', link: 'https://x/verify?token=t' });

    expect(log).toHaveBeenCalledWith('Magic link for someone@example.com: https://x/verify?token=t');
  });

  it('fails loudly rather than pretending to send when mail is off', async () => {
    await expect(new DisabledMailTransport().send(MESSAGE)).rejects.toThrow(/mail\.provider: none/);
  });
});

describe('smtpTransportOptions', () => {
  it('requires the STARTTLS upgrade for `starttls`', () => {
    expect(smtpTransportOptions(SMTP)).toMatchObject({ secure: false, requireTLS: true, ignoreTLS: false });
  });

  it('speaks TLS from the first byte for `tls`', () => {
    expect(smtpTransportOptions({ ...SMTP, port: 465, security: 'tls' })).toMatchObject({
      secure: true,
      requireTLS: false,
    });
  });

  it('never upgrades for `none`', () => {
    expect(smtpTransportOptions({ ...SMTP, port: 25, security: 'none' })).toMatchObject({
      secure: false,
      ignoreTLS: true,
    });
  });

  it('authenticates only when a user is configured, and never turns on nodemailer logging', () => {
    expect(smtpTransportOptions(SMTP).auth).toBeUndefined();
    const options = smtpTransportOptions({ ...SMTP, user: 'u', password: 'p' });
    expect(options.auth).toEqual({ user: 'u', pass: 'p' });
    expect(options).toMatchObject({ logger: false, debug: false });
  });
});

describe('formatSender', () => {
  it('quotes the display name and strips what could break out of it', () => {
    expect(formatSender({ from: 'a@example.com', fromName: 'Router, "Prod"\r\nBcc: x' })).toBe(
      '"Router, ProdBcc: x" <a@example.com>',
    );
  });
});

describe('ResendMailTransport', () => {
  it('posts both parts and the logo as an inline attachment', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await new ResendMailTransport('re_key', '"CR" <a@example.com>').send(MESSAGE);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.headers.authorization).toBe('Bearer re_key');
    expect(JSON.parse(init.body)).toEqual({
      from: '"CR" <a@example.com>',
      to: 'someone@example.com',
      subject: 'Subject',
      html: '<p>hi</p>',
      text: 'hi',
      attachments: [{ filename: 'logo.png', content: 'aGk=', content_type: 'image/png', content_id: 'logo' }],
    });
  });

  it('rejects with the status when Resend refuses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('domain not verified', { status: 403 })));

    await expect(new ResendMailTransport('k', 'a@example.com').send(MESSAGE)).rejects.toThrow(
      /403 domain not verified/,
    );
  });
});

describe('SmtpMailTransport', () => {
  it('hands nodemailer both parts and the logo as a cid attachment', async () => {
    const sendMail = vi.fn().mockResolvedValue({});
    const transport = new SmtpMailTransport({ sendMail, verify: vi.fn(), close: vi.fn() } as never, 'a@example.com');

    await transport.send(MESSAGE);

    expect(sendMail).toHaveBeenCalledWith({
      from: 'a@example.com',
      to: 'someone@example.com',
      subject: 'Subject',
      html: '<p>hi</p>',
      text: 'hi',
      attachments: [
        {
          filename: 'logo.png',
          content: 'aGk=',
          encoding: 'base64',
          contentType: 'image/png',
          cid: 'logo',
          contentDisposition: 'inline',
        },
      ],
    });
  });
});
