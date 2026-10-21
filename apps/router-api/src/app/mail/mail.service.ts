import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { routerConfig } from '../config.js';
import { type MailSettings, resolveMailSettings } from './mail-settings.js';
import { MAIL_TRANSPORT, type MailKind, MailProviderError, type MailTransport } from './mail-transport.js';
import { RecipientWindow } from './recipient-window.js';
import { type RenderedMail, renderMagicLinkMail, renderSignInCodeMail, renderWelcomeMail } from './templates.js';

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
  /**
   * Never `rejected`: that one is about a message rather than the mailer and
   * does not reach `state` at all, so the type says so rather than the
   * convention — see {@link MailFailureReason} and `reportFailure`.
   */
  reason?: MailerFailureReason;
  /** ISO time of the check or send `state` is from. */
  since?: string;
}

/**
 * `unreachable` is the one the egress question is about: the connection never
 * reached a mail server — DNS, a refused or timed-out connect, a dropped
 * socket. `auth_failed` means it did and the credentials were refused.
 *
 * `recipient_refused` is the only one that is about a single message rather
 * than the mailer, and so the only one that neither fails the request nor
 * makes `state` `failing` — see `deliver` and `reportFailure`. It is named
 * for the recipient on purpose: "the server refused this message" is far
 * wider than it sounds. A relay that will not take our *sender* — an
 * unverified domain, a suspended account — refuses at the same SMTP stage,
 * and so does one that will not carry the body at all; in both of those
 * nothing can be sent for anybody, which is the mailer being down. Everything
 * that is not provably about the recipient lands in `error` and flips the
 * state: a false `failing` costs one uniform refusal that the next good send
 * clears, and a false `ok` costs a `/health` that lies while the send route
 * goes back to answering an account differently from a stranger.
 */
export type MailFailureReason = 'unreachable' | 'auth_failed' | 'recipient_refused' | 'error';

/** The reasons that are the mailer's, and so the ones `/health` can report. */
export type MailerFailureReason = Exclude<MailFailureReason, 'recipient_refused'>;

/**
 * Whether the provider named the recipient it would not take.
 *
 * nodemailer sets `rejected` only where a recipient was the thing refused:
 * `_actionRCPT` on the all-recipients-rejected path, and the per-recipient
 * LMTP one (`smtp-connection/index.js`, nodemailer 8.0.11). The refusals that
 * are *not* the recipient carry the same `EENVELOPE` / `EMESSAGE` code and no
 * `rejected` at all — a `MAIL FROM` the relay would not accept, a `DATA`
 * stage it refused, the API-level envelope checks — which is exactly the
 * distinction the state needs and the code alone does not give.
 */
function namesRefusedRecipient(error: unknown): boolean {
  const rejected = (error as { rejected?: unknown } | null)?.rejected;
  return Array.isArray(rejected) && rejected.length > 0;
}

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
  // A provider that can name the cause has already done so. nodemailer cannot,
  // and leaves an SMTP `code` and a `rejected` list to read instead.
  if (error instanceof MailProviderError) {
    return error.failure;
  }
  if (namesRefusedRecipient(error)) {
    return 'recipient_refused';
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string') {
    if (UNREACHABLE_CODES.has(code)) {
      return 'unreachable';
    }
    if (code === 'EAUTH') {
      return 'auth_failed';
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
 * Two kinds of caller, two contracts. A sign-in code or link is awaited and
 * rejects when it could not be sent, and that rejection is what the requester
 * is told about: a 503 from either route, the same one for every address
 * (SUP-460, `mail-send-failure.plugin.ts`). Awaiting leaks nothing by it — a
 * code is mailed to any address that asks, account or not, so the answer and
 * the time it takes are the same for both. The welcome mail is fire-and-forget:
 * a sign-up must not fail because the greeting did not go out. Every failure
 * is the operator's to see, so each goes to the log at error level and into
 * `status()`, which `/health` reports.
 */
@Injectable()
export class MailService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(MailService.name);
  readonly settings: MailSettings;
  private readonly codeWindow: RecipientWindow;
  private readonly codeTtlMinutes: number;
  private current: MailStatus;
  /** Sends still in flight, so shutdown — and a test — can wait for them. */
  private readonly pending = new Set<Promise<void>>();

  constructor(
    @Inject(routerConfig.KEY) config: ConfigType<typeof routerConfig>,
    @Inject(MAIL_TRANSPORT) private readonly transport: MailTransport,
  ) {
    this.settings = resolveMailSettings(config);
    this.codeWindow = new RecipientWindow(config.auth.emailCode.mailsPerAddressPerHour, HOUR_MS);
    this.codeTtlMinutes = Math.max(1, Math.round(config.auth.emailCode.ttl / 60_000));
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
        (error: unknown) => {
          // The reason is `deliver`'s to act on; here it only has to be recorded.
          this.reportFailure('verify', error);
        },
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
    const mail = renderMagicLinkMail({ url, consoleUrl: this.settings.consoleUrl });
    await this.deliver({ to: email, kind: 'magic-link', mail, link: url, rethrow: true });
  }

  /**
   * A one-time sign-in code. Awaited, and a failed send rejects — for every
   * address alike, so it says nothing about who has an account.
   *
   * A recipient past their hourly allowance is the one case that resolves
   * without sending: the allowance exists so that nobody can flood somebody
   * else's inbox, and answering the flooder differently would hand them a way
   * to tell when the victim's sign-in has been silenced. Nothing downstream
   * can tell it from a send either — the route's refusal is decided from
   * `status()` and not from whether a particular request reached `deliver`
   * (`mail-send-failure.plugin.ts`).
   */
  async sendSignInCode(email: string, code: string): Promise<void> {
    if (!this.codeWindow.admit(email)) {
      this.logger.warn('Sign-in code not sent: this address has had its hourly allowance.');
      return;
    }
    const mail = renderSignInCodeMail({ code, consoleUrl: this.settings.consoleUrl, ttlMinutes: this.codeTtlMinutes });
    await this.deliver({ to: email, kind: 'sign-in-code', mail, code, rethrow: true });
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
    this.track(
      this.deliver({ to: input.email, kind: 'welcome', mail, link: this.settings.consoleUrl, rethrow: false }),
    );
  }

  private async deliver(job: {
    to: string;
    kind: MailKind;
    mail: RenderedMail;
    link?: string;
    code?: string;
    rethrow: boolean;
  }): Promise<void> {
    const { to, kind, mail, link, code } = job;
    try {
      await this.transport.send({ to, kind, link, code, ...mail });
      this.record({ state: 'ok' });
    } catch (error) {
      // A recipient the server will not take resolves, like a send this
      // deployment withheld: it is the one failure that is about the address
      // the caller named rather than about this deployment, so answering it
      // differently would tell a stranger apart from an account holder
      // wherever an address can be both refused and registered — a suppressed
      // recipient, a mailbox over quota. "Try again in a moment" would be a
      // lie as well; nothing about a retry changes it. The operator sees it in
      // the log, and SUP-462 is what will count it.
      if (this.reportFailure(kind, error) === 'recipient_refused') {
        return;
      }
      if (job.rethrow) {
        throw error;
      }
    }
  }

  private track(work: Promise<void>): void {
    const tracked = work.finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
  }

  /**
   * Logs a failure, and decides whether it was the *mailer* that failed.
   *
   * `recipient_refused` is not: the server took the connection, the
   * credentials and our sender, and would not take the one address this
   * message named. Letting that flip the deployment-wide state made the state
   * settable by anyone who could get one send attempted — a bogus address
   * through the fire-and-forget welcome mail, or one unspent invitation and a
   * recipient the relay refuses — and `mail-send-failure.plugin.ts` answers
   * the send route from that state, so an inducible `failing` is an inducible
   * refusal. Everything else is the mailer and still flips it, including the
   * refusals that merely look like this one: see {@link MailFailureReason} for
   * why the line is drawn at the recipient and defaults the other way.
   *
   * Returns the reason, which is also what `deliver` decides on.
   */
  private reportFailure(what: MailKind | 'verify', error: unknown): MailFailureReason {
    const reason = failureReasonOf(error);
    if (reason !== 'recipient_refused') {
      this.record({ state: 'failing', reason });
    }
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
    return reason;
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
