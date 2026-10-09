import type { RouterConfig } from '../config.schema.js';

export type MailProvider = 'none' | 'console' | 'resend' | 'smtp';

export type SmtpSecurity = 'starttls' | 'tls' | 'none';

export interface SmtpSettings {
  host: string;
  port: number;
  security: SmtpSecurity;
  user?: string;
  password?: string;
  connectTimeoutMs: number;
}

/** Everything about outbound mail, resolved once from both places it can be configured. */
export interface MailSettings {
  provider: MailProvider;
  from: string;
  fromName: string;
  /** Origin every link in a mail is built on — the console, never the API. */
  consoleUrl: string;
  resendApiKey?: string;
  smtp?: SmtpSettings;
}

const DEFAULT_SMTP_PORT: Record<SmtpSecurity, number> = { starttls: 587, tls: 465, none: 25 };

/**
 * Reads `mail`, falling back to `auth.magicLink` for whatever it leaves unset.
 *
 * `mail` is new in SUP-269 and `auth.magicLink` is what every chart before it
 * renders, so a deployment that says nothing in `mail` keeps exactly the
 * provider, sender and Resend key it had. The provider itself is not merged
 * key by key with the legacy block: `mail.provider` set means this section is
 * the whole answer, so an SMTP deployment cannot quietly inherit a Resend key.
 */
export function resolveMailSettings(config: Pick<RouterConfig, 'mail' | 'auth' | 'server'>): MailSettings {
  const { mail, auth, server } = config;
  const legacy = auth.magicLink;
  const provider: MailProvider = mail.provider ?? legacy.mailer;
  const fromLegacy = mail.provider === undefined;

  return {
    provider,
    from: mail.from ?? legacy.from,
    fromName: mail.fromName,
    consoleUrl: consoleUrlOf(mail.consoleUrl, server),
    resendApiKey: mail.resendApiKey ?? (fromLegacy ? blankToUndefined(legacy.resendApiKey) : undefined),
    smtp: mail.smtp
      ? {
          host: mail.smtp.host,
          port: mail.smtp.port ?? DEFAULT_SMTP_PORT[mail.smtp.security],
          security: mail.smtp.security,
          user: mail.smtp.user,
          password: mail.smtp.password,
          connectTimeoutMs: mail.smtp.connectTimeout,
        }
      : undefined,
  };
}

/** Whether this deployment can send mail at all. */
export function mailEnabled(config: Pick<RouterConfig, 'mail' | 'auth' | 'server'>): boolean {
  return resolveMailSettings(config).provider !== 'none';
}

/** Magic-link sign-in: on while there is a mailer, unless the deployment switched it off. */
export function magicLinkEnabled(config: Pick<RouterConfig, 'mail' | 'auth' | 'server'>): boolean {
  return mailEnabled(config) && config.auth.magicLink.enabled !== false;
}

/**
 * Password reset needs both halves: a password to reset, and a way to deliver
 * the link. Either one missing and the flow is not offered at all — the
 * routes 404 and the console shows no entry point (SUP-269 AC 2).
 */
export function passwordResetEnabled(config: Pick<RouterConfig, 'mail' | 'auth' | 'server'>): boolean {
  return config.auth.password.enabled && mailEnabled(config);
}

/**
 * The first concrete console origin. `*` is a CORS wildcard, not a place to
 * send anybody, so it is skipped; the API's own URL is the last resort, which
 * is right for a single-origin development setup and nowhere else.
 */
function consoleUrlOf(explicit: string | undefined, server: RouterConfig['server']): string {
  const origin =
    explicit ?? server.validClientOrigins.find((candidate: string) => candidate !== '*') ?? server.publicBaseUrl;
  return origin.replace(/\/+$/, '');
}

function blankToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
