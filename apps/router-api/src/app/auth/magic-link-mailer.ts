import { Logger } from '@nestjs/common';
import type { AuthConfig } from '../config.schema.js';

export interface MagicLinkMessage {
  email: string;
  url: string;
  token: string;
}

export interface MagicLinkMailer {
  send(message: MagicLinkMessage): Promise<void>;
}

export const MAGIC_LINK_MAILER = Symbol('MAGIC_LINK_MAILER');

/**
 * Dev/test mailer: writes the sign-in URL to the log instead of sending it.
 * Never selectable in production — `createMagicLinkMailer` rejects that at boot.
 */
export class ConsoleMagicLinkMailer implements MagicLinkMailer {
  private readonly logger = new Logger(ConsoleMagicLinkMailer.name);

  async send(message: MagicLinkMessage): Promise<void> {
    this.logger.log(`Magic link for ${message.email}: ${message.url}`);
  }
}

/** Resend's REST API is a single POST, so it needs no SDK. */
export class ResendMagicLinkMailer implements MagicLinkMailer {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(message: MagicLinkMessage): Promise<void> {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: this.from,
        to: message.email,
        subject: 'Sign in to Confidential Router',
        text: `Sign in with this link (it expires shortly):\n\n${message.url}\n\nIf you did not request it, ignore this email.`,
      }),
    });
    if (!response.ok) {
      throw new Error(`Resend rejected the magic-link email: ${response.status} ${await response.text()}`);
    }
  }
}

export function createMagicLinkMailer(auth: AuthConfig, nodeEnv = process.env.NODE_ENV): MagicLinkMailer {
  const { mailer, from, resendApiKey } = auth.magicLink;

  switch (mailer) {
    case 'console':
      if (nodeEnv === 'production') {
        throw new Error(
          'auth.magicLink.mailer is "console" in production: sign-in links would be written to the log ' +
            'instead of sent. Configure the "resend" mailer.',
        );
      }
      return new ConsoleMagicLinkMailer();
    case 'resend':
      if (!resendApiKey) {
        throw new Error('auth.magicLink.mailer is "resend" but auth.magicLink.resendApiKey is not set.');
      }
      return new ResendMagicLinkMailer(resendApiKey, from);
    case 'smtp':
      throw new Error(
        'auth.magicLink.mailer "smtp" is accepted by the config schema but not implemented yet. ' +
          'Use "resend", or "console" outside production.',
      );
    default:
      throw new Error(`Unknown auth.magicLink.mailer: ${String(mailer)}`);
  }
}
