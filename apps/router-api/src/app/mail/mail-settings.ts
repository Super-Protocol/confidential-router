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
  /** Where a reply goes, when the deployment named a mailbox that reads them. */
  replyTo?: string;
  /** Origin every link in a mail is built on — the console, never the API. */
  consoleUrl: string;
  resendApiKey?: string;
  /**
   * Verifies the provider's delivery notifications (SUP-551). Read whatever
   * `provider` is: production sends through the same provider's SMTP relay and
   * the webhook belongs to the account, not to the transport.
   */
  webhookSecret?: string;
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
    // No legacy twin: `auth.magicLink` never had one, so there is nothing to
    // fall back to and an older chart simply keeps sending without a Reply-To.
    replyTo: mail.replyTo,
    consoleUrl: consoleUrlOf(mail.consoleUrl, server),
    resendApiKey: mail.resendApiKey ?? (fromLegacy ? blankToUndefined(legacy.resendApiKey) : undefined),
    // No legacy twin, and no fallback to the provider: the webhook is a
    // property of the mail account and is configured once, for the deployment.
    webhookSecret: mail.webhookSecret,
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

/** Magic-link sign-in, beside the code: on while there is a mailer, unless the deployment switched it off. */
export function magicLinkEnabled(config: Pick<RouterConfig, 'mail' | 'auth' | 'server'>): boolean {
  return mailEnabled(config) && config.auth.magicLink.enabled !== false;
}

/**
 * Sign-in by emailed code: on exactly while there is somewhere to mail it from.
 * Without a mailer the routes are not mounted and the console offers no code
 * field — such a deployment signs in by OAuth or the bootstrap token only.
 */
export function emailCodeEnabled(config: Pick<RouterConfig, 'mail' | 'auth' | 'server'>): boolean {
  return mailEnabled(config);
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
