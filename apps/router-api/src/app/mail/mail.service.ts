import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { routerConfig } from '../config.js';
import { type MailSettings, passwordResetEnabled, resolveMailSettings } from './mail-settings.js';
import { MAIL_TRANSPORT, type MailKind, type MailTransport } from './mail-transport.js';
import { RecipientWindow } from './recipient-window.js';
import { type RenderedMail, renderMagicLinkMail, renderPasswordResetMail, renderWelcomeMail } from './templates.js';

/**
 * Where the mail path stands, as `/health` reports it.
 *
 * Deliberately coarse: `/health` is public, and the SMTP host, the account and
 * the server's own words stay in the log. `reason` is enough for an operator
 * to know which half to look at — the network or the credentials.
 */
export interface MailStatus {
  provider: MailSettings['provider'];
  /**
   * `disabled` — no provider; `unverified` — nothing has been checked or sent
   * yet, or the provider has no check; `ok` — the last check or send worked;
   * `failing` — the last one did not.
   */
  state: 'disabled' | 'unverified' | 'ok' | 'failing';
  reason?: MailFailureReason;
  /** ISO time of the check or send `state` is from. */
  since?: string;
}

/**
 * `unreachable` is the one the egress question is about: the connection never
 * reached a mail server — DNS, a refused or timed-out connect, a dropped
 * socket. `auth_failed` means it did and the credentials were refused;
 * `rejected` is the server refusing the message itself.
 */
export type MailFailureReason = 'unreachable' | 'auth_failed' | 'rejected' | 'error';

const UNREACHABLE_CODES = new Set([
  'ECONNECTION',
  'ETIMEDOUT',
  'ESOCKET',
  'EDNS',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

export function failureReasonOf(error: unknown): MailFailureReason {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string') {
    if (UNREACHABLE_CODES.has(code)) {
      return 'unreachable';
    }
    if (code === 'EAUTH') {
      return 'auth_failed';
    }
    if (code === 'EENVELOPE' || code === 'EMESSAGE') {
      return 'rejected';
    }
  }
  // `fetch` (Resend) fails a connect with a TypeError whose cause carries the code.
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  if (typeof cause?.code === 'string' && UNREACHABLE_CODES.has(cause.code)) {
    return 'unreachable';
  }
  return 'error';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const HOUR_MS = 3_600_000;

/**
 * Every transactional mail this deployment sends, rendered from one template
 * set and delivered through whichever provider is configured (SUP-269).
 *
 * Two kinds of caller, two contracts. A sign-in link is awaited and its
 * failure is the requester's — they are waiting for it, and a silent success
 * would leave them refreshing an empty inbox. A reset link and a welcome mail
 * are fire-and-forget: the reset request must answer the same way and in the
 * same time whether or not the address has an account, and a sign-up must not
 * fail because the greeting did not go out. Their failures are the operator's,
 * so they go to the log at error level and into `status()`.
 */
@Injectable()
export class MailService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(MailService.name);
  readonly settings: MailSettings;
  private readonly resetWindow: RecipientWindow;
  private readonly resetTtlMinutes: number;
  private readonly resetOffered: boolean;
  private current: MailStatus;
  /** Sends still in flight, so shutdown — and a test — can wait for them. */
  private readonly pending = new Set<Promise<void>>();

  constructor(
    @Inject(routerConfig.KEY) config: ConfigType<typeof routerConfig>,
    @Inject(MAIL_TRANSPORT) private readonly transport: MailTransport,
  ) {
    this.settings = resolveMailSettings(config);
    this.resetWindow = new RecipientWindow(config.auth.passwordReset.mailsPerAddressPerHour, HOUR_MS);
    this.resetTtlMinutes = Math.max(1, Math.round(config.auth.passwordReset.tokenTtl / 60_000));
    this.resetOffered = passwordResetEnabled(config);
    this.current = { provider: this.settings.provider, state: this.enabled ? 'unverified' : 'disabled' };
  }

  get enabled(): boolean {
    return this.settings.provider !== 'none';
  }

  status(): MailStatus {
    return { ...this.current };
  }

  /**
   * Checks the provider once at boot, without holding the boot up: a mail
   * server that is slow to greet must not keep the API out of rotation, and a
   * misconfigured one must be *visible* — the first failure mode SUP-269 names
   * is mail that silently goes nowhere.
   */
  onApplicationBootstrap(): void {
    if (this.settings.provider !== 'smtp') {
      return;
    }
    this.track(
      this.transport.verify().then(
        () => {
          this.record({ state: 'ok' });
          this.logger.log(`SMTP server ${this.describeSmtp()} accepted the connection and credentials.`);
        },
        (error: unknown) => this.reportFailure('verify', error),
      ),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.settle();
    (this.transport as { close?: () => void }).close?.();
  }

  /** Resolves once every fire-and-forget send started so far has finished. */
  async settle(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }

  /** A one-time sign-in link. Awaited: the requester is waiting for it. */
  async sendMagicLink(email: string, url: string): Promise<void> {
    await this.deliver(
      email,
      'magic-link',
      renderMagicLinkMail({ url, consoleUrl: this.settings.consoleUrl }),
      url,
      true,
    );
  }

  /**
   * A reset link, for a request Better Auth has already matched to an account.
   *
   * Returns before anything is sent. Better Auth awaits this callback only for
   * an address that exists, so awaiting the SMTP round trip here would make the
   * answer measurably slower for a real account than for an unknown one — the
   * enumeration the uniform response is meant to prevent.
   */
  requestPasswordReset(email: string, token: string): void {
    if (!this.resetOffered) {
      return;
    }
    if (!this.resetWindow.admit(email)) {
      this.logger.warn('Password reset mail not sent: this address has had its hourly allowance.');
      return;
    }
    const url = `${this.settings.consoleUrl}/reset-password?token=${encodeURIComponent(token)}`;
    const mail = renderPasswordResetMail({
      url,
      consoleUrl: this.settings.consoleUrl,
      ttlMinutes: this.resetTtlMinutes,
    });
    this.track(this.deliver(email, 'password-reset', mail, url, false));
  }

  /** The welcome mail after a sign-up. Never fails the sign-up. */
  sendWelcome(input: { email: string; name?: string | null; startingCreditMicros: number }): void {
    if (!this.enabled) {
      return;
    }
    if (undeliverable(input.email)) {
      // The bootstrap default, `admin@confidential-router.local`: `.local` is
      // link-local by RFC 6762 and no public mail server will take it.
      return;
    }
    const mail = renderWelcomeMail({
      name: input.name,
      consoleUrl: this.settings.consoleUrl,
      startingCreditMicros: input.startingCreditMicros,
    });
    this.track(this.deliver(input.email, 'welcome', mail, this.settings.consoleUrl, false));
  }

  // biome-ignore lint/complexity/useMaxParams: private, and every argument is distinct.
  private async deliver(to: string, kind: MailKind, mail: RenderedMail, link: string, rethrow: boolean): Promise<void> {
    try {
      await this.transport.send({ to, kind, link, ...mail });
      this.record({ state: 'ok' });
    } catch (error) {
      this.reportFailure(kind, error);
      if (rethrow) {
        throw error;
      }
    }
  }

  private track(work: Promise<void>): void {
    const tracked = work.finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
  }

  private reportFailure(what: MailKind | 'verify', error: unknown): void {
    const reason = failureReasonOf(error);
    this.record({ state: 'failing', reason });
    const where = this.settings.provider === 'smtp' ? ` (SMTP ${this.describeSmtp()})` : ` (${this.settings.provider})`;
    const hint =
      reason === 'unreachable'
        ? ' The mail server could not be reached from this deployment: check the host and port, that the cloud ' +
          'allows outbound connections on that port, and that the host does not resolve to a private address — ' +
          'a cluster space only admits egress to public ones.'
        : reason === 'auth_failed'
          ? ' The server refused the configured credentials.'
          : '';
    const action = what === 'verify' ? 'Mail check failed' : `The "${what}" email was not delivered`;
    this.logger.error(`${action}${where}: ${messageOf(error)}.${hint}`);
  }

  private record(next: Pick<MailStatus, 'state' | 'reason'>): void {
    this.current = { provider: this.settings.provider, ...next, since: new Date().toISOString() };
  }

  private describeSmtp(): string {
    const smtp = this.settings.smtp;
    return smtp ? `${smtp.host}:${smtp.port}, ${smtp.security}` : 'unconfigured';
  }
}

function undeliverable(email: string): boolean {
  return /\.local$/i.test(email.trim());
}
