import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { routerConfig } from '../config.js';
import { type MailSettings, resolveMailSettings } from './mail-settings.js';
import { MAIL_TRANSPORT, type MailKind, type MailTransport } from './mail-transport.js';
import { RecipientWindow } from './recipient-window.js';
import { type RenderedMail, renderMagicLinkMail, renderSignInCodeMail, renderWelcomeMail } from './templates.js';

/**
 * Where the mail path stands, as `/health` reports it.
 *
 * Deliberately coarse: `/health` is public, and the SMTP host, the account and
 * the server's own words stay in the log. `reason` is enough for an operator
 * to know which half to look at — the network or the credentials.
 *
 * About the **transport**, and only that. A send the deployment chose not to
 * make never touches this, because it says nothing about whether the transport
 * works; see {@link MailWithheldTally} for that half.
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

/**
 * Why a mail this deployment was asked for never left the process.
 *
 * Neither is a fault, and neither is visible to the caller by design: the route
 * runs to completion and answers exactly as it answers a send. For
 * `no_invitation` that is the whole point — an observable refusal is an
 * account-existence oracle, which is what SUP-410 exists to prevent — and for
 * `rate_limited` it is the same argument about somebody else's inbox.
 * `unused_code_type` is the third: the send route accepts three `type`s and
 * this deployment mails one, so a client asking for either of the others is
 * answered `200` and sent nothing.
 *
 * That argument bounds what the **response** may say. It never bounded what the
 * deployment's own operator may see, and before SUP-462 the two were conflated:
 * the reason lived in a log line inside a published cluster space that cannot
 * be exec'd into, so in practice it lived nowhere, and a withheld send was
 * indistinguishable from a broken transport. Those have opposite remedies.
 */
export type MailWithheldReason = 'no_invitation' | 'rate_limited' | 'unused_code_type';

/**
 * Withheld sends since this process started, counted by reason.
 *
 * Aggregate only, and never per address. A queryable list of withheld
 * addresses would rebuild the very oracle the gate is there to deny; counts
 * answer the operator's question ("is it withheld or is it broken?") without
 * answering the attacker's ("does this address have an account?").
 */
export interface MailWithheldTally {
  /**
   * Sign-up mail an invite-only deployment withheld because the request
   * carried no invitation it would admit (SUP-410).
   */
  noInvitation: number;
  /** Sign-in codes withheld because that recipient had already had their hourly allowance. */
  rateLimited: number;
  /**
   * Code requests for a `type` this deployment does not mail — the two the
   * email-OTP plugin offers beside `sign-in`, whose own routes are disabled
   * (`UNUSED_EMAIL_OTP_PATHS`). A client asking for one is a client bug, and
   * it looks exactly like mail that stopped arriving.
   */
  unusedCodeType: number;
  /**
   * ISO time of the most recent withheld send. Not `since`: `MailStatus.since`
   * is the start of a state that still holds, and this is a latest occurrence.
   */
  lastWithheldAt: string;
}

/**
 * {@link MailStatus} plus what was withheld — the operator's whole answer to
 * "the sign-in mail is not arriving".
 *
 * **Not for an unauthenticated surface.** Every field here moves in response to
 * one request, so a caller who can read it before and after posting an address
 * learns whether that address was mailed — which is the oracle again, by
 * subtraction. `status()` is the half `/health` may publish; this one is behind
 * `SessionGuard` + `AdminGuard` (see `MailDeliveryResolver`).
 */
export interface MailDeliveryReport extends MailStatus {
  /** Absent until this process has withheld something. */
  withheld?: MailWithheldTally;
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
 * What the log says for each reason, or `null` where somebody else already says
 * it. No address in any of them: the recipient is the one thing a withheld-send
 * record must not keep, and the counter the operator reads is aggregate for the
 * same reason.
 */
const WITHHELD_LOG: Record<MailWithheldReason, string | null> = {
  // Nothing. `SignUpGate.admits` logs this refusal already, and with the one
  // detail that matters — *which* refusal it was: `missing`, `spent`, `expired`
  // or `withdrawn`. A second line opening with the same five words and less in
  // it would make grep-counting the event double-count it, and would sit next
  // to the only line worth reading. The count is this record's contribution.
  no_invitation: null,
  rate_limited: 'Sign-in code not sent: this address has had its hourly allowance.',
  unused_code_type:
    'No code mailed: the request asked for a code `type` this deployment does not use — only "sign-in" is ' +
    'mailed, and the flows the other types belong to have their routes disabled. The count is on ' +
    '`mailDelivery`.',
};

const EMPTY_TALLY: Omit<MailWithheldTally, 'lastWithheldAt'> = { noInvitation: 0, rateLimited: 0, unusedCodeType: 0 };

/** Which counter each reason increments — a map rather than a branch, so a new reason cannot forget one. */
const WITHHELD_COUNTER: Record<MailWithheldReason, keyof typeof EMPTY_TALLY> = {
  no_invitation: 'noInvitation',
  rate_limited: 'rateLimited',
  unused_code_type: 'unusedCodeType',
};

/**
 * Every transactional mail this deployment sends, rendered from one template
 * set and delivered through whichever provider is configured (SUP-269).
 *
 * Two kinds of caller, two contracts. A sign-in code or link is awaited and
 * rejects when it could not be sent; what the requester then sees is Better
 * Auth's decision, and for a code it is nothing — the send route swallows the
 * failure and answers every address alike. Awaiting leaks nothing either way:
 * a code is mailed to any address that asks, account or not, so the answer and
 * the time it takes are the same for both. The welcome mail is fire-and-forget:
 * a sign-up must not fail because the greeting did not go out. Every failure
 * is the operator's to see, so each goes to the log at error level and into
 * `status()`, which `/health` reports. A send the deployment *chose* not to
 * make is the operator's to see too, and is counted separately — the response
 * stays identical, which is the whole constraint (SUP-462).
 */
@Injectable()
export class MailService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(MailService.name);
  readonly settings: MailSettings;
  private readonly codeWindow: RecipientWindow;
  private readonly codeTtlMinutes: number;
  private current: MailStatus;
  private withheld: MailWithheldTally | undefined;
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
   * Where mail stands *and* what was deliberately not sent (SUP-462).
   *
   * Operator-only — read the warning on {@link MailDeliveryReport} before
   * putting this anywhere a stranger can reach.
   */
  delivery(): MailDeliveryReport {
    return { ...this.status(), ...(this.withheld ? { withheld: { ...this.withheld } } : {}) };
  }

  /**
   * Records a mail this deployment chose not to send.
   *
   * Synchronous, total, and never awaited. It is called from the send callbacks
   * on the request path, and the one thing a withheld send must not do is make
   * the request look different: anything that could throw, block or take a
   * measurable moment here would hand the caller back the difference the gate
   * spent SUP-410 removing. An integer increment is none of those.
   *
   * A withheld send is deliberately *not* a `record()`: it says nothing about
   * whether the transport works, so it must not overwrite `ok` or clear
   * `failing`. The two facts are orthogonal and conflating them into one state
   * is the defect, not the fix.
   */
  recordWithheld(reason: MailWithheldReason): void {
    const tally = this.withheld ?? { ...EMPTY_TALLY, lastWithheldAt: '' };
    tally[WITHHELD_COUNTER[reason]] += 1;
    tally.lastWithheldAt = new Date().toISOString();
    this.withheld = tally;
    const line = WITHHELD_LOG[reason];
    if (line) {
      this.logger.warn(line);
    }
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
   * to tell when the victim's sign-in has been silenced.
   */
  async sendSignInCode(email: string, code: string): Promise<void> {
    if (!this.codeWindow.admit(email)) {
      this.recordWithheld('rate_limited');
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
      this.reportFailure(kind, error);
      if (job.rethrow) {
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
