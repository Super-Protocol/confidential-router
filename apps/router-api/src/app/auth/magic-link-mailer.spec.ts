import { describe, expect, it, vi } from 'vitest';
import type { AuthConfig } from '../config.schema.js';
import {
  ConsoleMagicLinkMailer,
  createMagicLinkMailer,
  DisabledMagicLinkMailer,
  type MagicLinkMailer,
  ResendMagicLinkMailer,
} from './magic-link-mailer.js';

function authConfig(magicLink: Partial<AuthConfig['magicLink']>): AuthConfig {
  return {
    baseUrl: 'http://localhost:3000',
    secret: 'x'.repeat(32),
    sessionMaxAge: 2_592_000_000,
    magicLink: { mailer: 'console', from: 'no-reply@example.com', ...magicLink },
  } as AuthConfig;
}

describe('createMagicLinkMailer', () => {
  it('uses the console mailer in development', () => {
    expect(createMagicLinkMailer(authConfig({ mailer: 'console' }), 'development')).toBeInstanceOf(
      ConsoleMagicLinkMailer,
    );
  });

  it('refuses the console mailer in production', () => {
    // Otherwise every sign-in link for every user would be written to the log.
    expect(() => createMagicLinkMailer(authConfig({ mailer: 'console' }), 'production')).toThrow(/written to the log/);
  });

  it('builds the Resend mailer when an API key is configured', () => {
    expect(createMagicLinkMailer(authConfig({ mailer: 'resend', resendApiKey: 'key' }), 'production')).toBeInstanceOf(
      ResendMagicLinkMailer,
    );
  });

  it('refuses the Resend mailer without an API key', () => {
    expect(() => createMagicLinkMailer(authConfig({ mailer: 'resend' }), 'production')).toThrow(/resendApiKey/);
  });

  it('builds a disabled mailer in production when there is no mail provider at all', () => {
    // The deployment this exists for — a marketplace install with no mailer and
    // no OAuth app — has to be able to boot in production; `console` is refused
    // there and `resend` needs a key it does not have.
    expect(createMagicLinkMailer(authConfig({ mailer: 'none' }), 'production')).toBeInstanceOf(DisabledMagicLinkMailer);
  });

  it('says plainly that SMTP is not implemented rather than failing later', () => {
    expect(() => createMagicLinkMailer(authConfig({ mailer: 'smtp' }), 'development')).toThrow(/not implemented/);
  });
});

describe('DisabledMagicLinkMailer', () => {
  it('refuses to send instead of pretending it did', async () => {
    // Through the interface: this is the shape `AuthService` holds, and the
    // point is that nothing can call it and believe a link went out.
    const mailer: MagicLinkMailer = new DisabledMagicLinkMailer();

    await expect(mailer.send({ email: 'dev@example.com', url: 'http://localhost/', token: 't' })).rejects.toThrow(
      /disabled/,
    );
  });
});

describe('ResendMagicLinkMailer', () => {
  it('posts the link to Resend', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await new ResendMagicLinkMailer('api-key', 'no-reply@example.com').send({
      email: 'dev@example.com',
      url: 'http://localhost:3000/auth/magic-link/verify?token=t',
      token: 't',
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.authorization).toBe('Bearer api-key');
    expect(JSON.parse(init.body).to).toBe('dev@example.com');
    expect(JSON.parse(init.body).text).toContain('token=t');
    vi.unstubAllGlobals();
  });

  it('throws when Resend rejects the message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 422 })));

    await expect(
      new ResendMagicLinkMailer('api-key', 'no-reply@example.com').send({
        email: 'dev@example.com',
        url: 'http://localhost/',
        token: 't',
      }),
    ).rejects.toThrow(/422/);

    vi.unstubAllGlobals();
  });
});
