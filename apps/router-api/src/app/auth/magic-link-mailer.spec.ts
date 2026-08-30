import { describe, expect, it, vi } from 'vitest';
import type { AuthConfig } from '../config.schema.js';
import { ConsoleMagicLinkMailer, createMagicLinkMailer, ResendMagicLinkMailer } from './magic-link-mailer.js';

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

  it('says plainly that SMTP is not implemented rather than failing later', () => {
    expect(() => createMagicLinkMailer(authConfig({ mailer: 'smtp' }), 'development')).toThrow(/not implemented/);
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
