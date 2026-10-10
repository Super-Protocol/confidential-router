import { Logger } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import type { MailSettings } from './mail-settings.js';

/** Which flow a message belongs to — logged, and how tests find the one they want. */
export type MailKind = 'magic-link' | 'sign-in-code' | 'welcome';

/** An image the HTML refers to as `cid:<contentId>` rather than by URL. */
export interface InlineImage {
  contentId: string;
  filename: string;
  contentType: string;
  /** Base64, no line breaks. */
  content: string;
}

/** A rendered message, ready for whichever provider is configured. */
export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  inlineImages: InlineImage[];
  kind: MailKind;
  /**
   * The one link the message exists to deliver, when it has one. Never sent as
   * a field of its own — it is already in `html` and `text` — but a transport
   * that only records (the console one, the e2e harness) needs it without
   * parsing a body.
   */
  link?: string;
  /** The one-time code of a `sign-in-code` message, for the same two readers. */
  code?: string;
}

/**
 * Delivers a rendered message. Rejects when the provider refused it or could
 * not be reached; the caller decides whether that is the requester's problem
 * (a sign-in link) or only the operator's (a welcome mail).
 */
export interface MailTransport {
  readonly provider: MailSettings['provider'];
  send(message: MailMessage): Promise<void>;
  /**
   * Proves the provider is reachable and accepts these credentials, without
   * sending anything. Resolves for providers that have nothing to probe.
   */
  verify(): Promise<void>;
}

export const MAIL_TRANSPORT = Symbol('MAIL_TRANSPORT');

/**
 * Refuses to send anything: `provider: none` means the deployment has no mail.
 *
 * Every flow that would reach this is switched off on such a deployment —
 * magic link and password reset are unregistered, the welcome mail is skipped
 * — so it exists for a future caller that forgot to check, which should fail
 * loudly rather than appear to send.
 */
export class DisabledMailTransport implements MailTransport {
  readonly provider = 'none' as const;

  async send(message: MailMessage): Promise<void> {
    throw new Error(`Mail is disabled on this deployment (mail.provider: none); "${message.kind}" was not sent.`);
  }

  async verify(): Promise<void> {}
}

/** How each kind reads in the log. `Magic link for` is load-bearing: `tools/demo` matches it. */
const CONSOLE_LABEL: Record<MailKind, string> = {
  'magic-link': 'Magic link',
  'sign-in-code': 'Sign-in code',
  welcome: 'Welcome mail',
};

/**
 * Dev/test transport: writes the recipient and the link to the log. Never
 * selectable in production — `createMailTransport` rejects that at boot.
 */
export class ConsoleMailTransport implements MailTransport {
  readonly provider = 'console' as const;
  private readonly logger = new Logger(ConsoleMailTransport.name);

  async send(message: MailMessage): Promise<void> {
    this.logger.log(
      `${CONSOLE_LABEL[message.kind]} for ${message.to}: ${message.code ?? message.link ?? message.subject}`,
    );
  }

  async verify(): Promise<void> {}
}

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/** Resend's REST API is a single POST, so it needs no SDK. */
export class ResendMailTransport implements MailTransport {
  readonly provider = 'resend' as const;

  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(message: MailMessage): Promise<void> {
    const response = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: this.from,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
        // Resend embeds an attachment carrying `content_id` inline, which is what
        // `cid:` in the HTML refers to.
        attachments: message.inlineImages.map((image) => ({
          filename: image.filename,
          content: image.content,
          content_type: image.contentType,
          content_id: image.contentId,
        })),
      }),
    });
    if (!response.ok) {
      throw new Error(`Resend rejected the "${message.kind}" email: ${response.status} ${await response.text()}`);
    }
  }

  /** Resend has no credential check that sends nothing; a bad key surfaces on the first send. */
  async verify(): Promise<void> {}
}

/** Any SMTP server, through nodemailer. */
export class SmtpMailTransport implements MailTransport {
  readonly provider = 'smtp' as const;

  constructor(
    private readonly transporter: Pick<Transporter, 'sendMail' | 'verify' | 'close'>,
    private readonly from: string,
  ) {}

  async send(message: MailMessage): Promise<void> {
    await this.transporter.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
      attachments: message.inlineImages.map((image) => ({
        filename: image.filename,
        content: image.content,
        encoding: 'base64',
        contentType: image.contentType,
        cid: image.contentId,
        contentDisposition: 'inline' as const,
      })),
    });
  }

  async verify(): Promise<void> {
    await this.transporter.verify();
  }

  close(): void {
    this.transporter.close();
  }
}

/** The nodemailer options for a set of SMTP settings. Exported for its test. */
export function smtpTransportOptions(smtp: NonNullable<MailSettings['smtp']>) {
  return {
    host: smtp.host,
    port: smtp.port,
    // Implicit TLS from the first byte only for `tls`; the other two start in
    // cleartext and differ in whether an upgrade is mandatory.
    secure: smtp.security === 'tls',
    requireTLS: smtp.security === 'starttls',
    ignoreTLS: smtp.security === 'none',
    auth: smtp.user ? { user: smtp.user, pass: smtp.password ?? '' } : undefined,
    connectionTimeout: smtp.connectTimeoutMs,
    greetingTimeout: smtp.connectTimeoutMs,
    socketTimeout: smtp.connectTimeoutMs * 3,
    // nodemailer's own logger would print the AUTH exchange; this process logs
    // outcomes itself, without the credentials.
    logger: false,
    debug: false,
  };
}

/** `Name <address>`, quoted so a display name with a comma stays one mailbox. */
export function formatSender(settings: Pick<MailSettings, 'from' | 'fromName'>): string {
  const name = settings.fromName.replace(/["\\\r\n]/g, '');
  return `"${name}" <${settings.from}>`;
}

export function createMailTransport(settings: MailSettings, nodeEnv = process.env.NODE_ENV): MailTransport {
  const from = formatSender(settings);

  switch (settings.provider) {
    case 'none':
      return new DisabledMailTransport();
    case 'console':
      if (nodeEnv === 'production') {
        throw new Error(
          'The mail provider is "console" in production: sign-in codes and links would be written to the log ' +
            'instead of sent. Configure mail.provider "smtp" or "resend", or "none".',
        );
      }
      return new ConsoleMailTransport();
    case 'resend':
      if (!settings.resendApiKey) {
        throw new Error('The mail provider is "resend" but no Resend API key is set (mail.resendApiKey).');
      }
      return new ResendMailTransport(settings.resendApiKey, from);
    case 'smtp':
      if (!settings.smtp) {
        throw new Error('The mail provider is "smtp" but mail.smtp.host is not set.');
      }
      return new SmtpMailTransport(createTransport(smtpTransportOptions(settings.smtp)), from);
    default:
      throw new Error(`Unknown mail provider: ${String(settings.provider)}`);
  }
}
