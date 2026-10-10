import { describe, expect, it } from 'vitest';
import { RouterConfigSchema } from '../config.schema.js';
import { emailCodeEnabled, magicLinkEnabled, resolveMailSettings } from './mail-settings.js';

function config(input: Record<string, unknown> = {}) {
  return RouterConfigSchema.parse({
    auth: { secret: 's'.repeat(32), ...((input.auth as object) ?? {}) },
    server: { validClientOrigins: ['https://console.example.com/'], ...((input.server as object) ?? {}) },
    mail: input.mail,
  });
}

describe('resolveMailSettings', () => {
  it('falls back to auth.magicLink when `mail` says nothing — a pre-SUP-269 chart boots unchanged', () => {
    const settings = resolveMailSettings(
      config({ auth: { magicLink: { mailer: 'resend', from: 'old@example.com', resendApiKey: 're_key' } } }),
    );

    expect(settings).toMatchObject({ provider: 'resend', from: 'old@example.com', resendApiKey: 're_key' });
  });

  it('takes the provider from `mail` over the legacy block, without inheriting its Resend key', () => {
    const settings = resolveMailSettings(
      config({
        auth: { magicLink: { mailer: 'resend', resendApiKey: 're_key' } },
        mail: { provider: 'smtp', from: 'mail@example.com', smtp: { host: 'smtp.example.com' } },
      }),
    );

    expect(settings.provider).toBe('smtp');
    expect(settings.from).toBe('mail@example.com');
    expect(settings.resendApiKey).toBeUndefined();
  });

  it.each([
    ['starttls', 587],
    ['tls', 465],
    ['none', 25],
  ])('defaults the port for %s to %i', (security, port) => {
    const settings = resolveMailSettings(
      config({ mail: { provider: 'smtp', smtp: { host: 'smtp.example.com', security } } }),
    );

    expect(settings.smtp).toMatchObject({ host: 'smtp.example.com', port, security });
  });

  it('treats a blank user and password as no authentication — a chart renders unset values as ""', () => {
    const settings = resolveMailSettings(
      config({ mail: { provider: 'smtp', smtp: { host: 'smtp.example.com', user: '', password: '' } } }),
    );

    expect(settings.smtp?.user).toBeUndefined();
    expect(settings.smtp?.password).toBeUndefined();
  });

  it('builds links on the console origin, not the API', () => {
    expect(resolveMailSettings(config()).consoleUrl).toBe('https://console.example.com');
  });

  it('skips a CORS wildcard when looking for the console', () => {
    const settings = resolveMailSettings(
      config({
        server: { validClientOrigins: ['*', 'https://app.example.com'], publicBaseUrl: 'https://api.example.com' },
      }),
    );

    expect(settings.consoleUrl).toBe('https://app.example.com');
  });

  it('prefers an explicit consoleUrl', () => {
    expect(resolveMailSettings(config({ mail: { consoleUrl: 'https://elsewhere.example.com' } })).consoleUrl).toBe(
      'https://elsewhere.example.com',
    );
  });
});

describe('which flows a mailer turns on', () => {
  it('offers the emailed code exactly while there is a mailer', () => {
    expect(emailCodeEnabled(config({ mail: { provider: 'smtp', smtp: { host: 'h' } } }))).toBe(true);
    expect(emailCodeEnabled(config())).toBe(true);
    expect(emailCodeEnabled(config({ auth: { magicLink: { mailer: 'none' } } }))).toBe(false);
    expect(emailCodeEnabled(config({ mail: { provider: 'none' } }))).toBe(false);
  });

  it('lets a deployment keep the magic link off while the code stays on', () => {
    const smtp = { provider: 'smtp', smtp: { host: 'h' } };

    expect(magicLinkEnabled(config({ mail: smtp }))).toBe(true);
    const codeOnly = config({ mail: smtp, auth: { magicLink: { enabled: false } } });
    expect(magicLinkEnabled(codeOnly)).toBe(false);
    expect(emailCodeEnabled(codeOnly)).toBe(true);
  });
});
