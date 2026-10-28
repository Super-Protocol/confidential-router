import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { routerConfig } from '../config.js';
import { MailService, type OperatorAlert, type OperatorAlertDelivery } from '../mail/mail.service.js';

/** How the alert channel stands, as `/health` and `/admin/health` report it. */
export interface AlertChannelStatus {
  /**
   * - `disabled` — `alerts.email` is off, or the deployment has no mail provider.
   * - `unconfigured` — enabled, with nobody to write to: neither `alerts.emails`
   *   nor `auth.adminEmails` names an address. This is the state SUP-535 exists
   *   to make visible, because it is indistinguishable from "quiet" otherwise.
   * - `ready` — enabled, with recipients, and nothing has failed yet.
   * - `ok` — the last alert reached at least one of them.
   * - `failing` — the last alert reached none of them.
   */
  state: 'disabled' | 'unconfigured' | 'ready' | 'ok' | 'failing';
  /** How many addresses an alert would go to. Never the addresses themselves. */
  recipients: number;
  /** ISO time of the last attempt, absent until there has been one. */
  lastAttemptAt?: string;
  /** Alerts suppressed by `alerts.minInterval` since the last one that was sent. */
  suppressed?: number;
}

/**
 * The outbound half of an alert (SUP-535).
 *
 * SUP-517 detects an upstream that stopped serving, writes an `ERROR` line, a
 * timeline row and a `/health` status — and stops there, on the argument that
 * this deployment has no pager and inventing an outbound channel would be a
 * second thing to keep working. That argument is wrong in one specific way: a log
 * line is an alert only where something watches the log, and nothing watches this
 * one. Both production outages so far were found by a person stumbling over them.
 *
 * So this is the outbound path, and it is deliberately the channel this
 * deployment already proves every day: the mail provider the sign-in codes go out
 * through. Nothing new to keep working — if mail breaks, sign-in breaks first and
 * much more loudly, and `/health` reports both.
 *
 * Three properties the callers depend on:
 *
 * - **It never throws.** Every caller is a background pass that has already
 *   recorded the thing it is reporting. A mail server that is down must not turn
 *   a detected outage into an undetected one.
 * - **It is rate-limited** by `alerts.minInterval`, across all raisers. The
 *   per-run latch upstream already stops one outage sending twice; this stops a
 *   flapping upstream — a run that ends and begins again — from filling a mailbox,
 *   because a flooded mailbox grows a filter and then the next alert is lost for
 *   good. What was suppressed is counted and said out loud in the next message.
 *   The interval is armed by a message that **landed**: a send that reached
 *   nobody put nothing in a mailbox, and arming on it would spend the next
 *   quarter-hour's alerting budget on a message that does not exist.
 * - **It reports what happened**, not what is configured. `status()` is the
 *   difference between "a channel exists" and "a human was written to".
 */
@Injectable()
export class OperatorAlertsService {
  private readonly logger = new Logger(OperatorAlertsService.name);
  private lastSentAt: number | null = null;
  private lastAttemptAt: Date | null = null;
  private lastDelivered: boolean | null = null;
  private suppressed = 0;

  constructor(
    @Inject(routerConfig.KEY) private readonly config: ConfigType<typeof routerConfig>,
    private readonly mail: MailService,
  ) {}

  /**
   * Who an alert goes to: `alerts.emails`, or the operators the admin section
   * already names.
   *
   * The fallback is the design. A channel that needs a new deploy parameter is a
   * channel that is unset on the deployment already running, which is exactly the
   * deployment the outage happens on.
   */
  get recipients(): string[] {
    const named = this.config.alerts.emails;
    return named.length > 0 ? named : this.config.auth.adminEmails;
  }

  get enabled(): boolean {
    return this.config.alerts.email && this.mail.enabled;
  }

  status(): AlertChannelStatus {
    const recipients = this.recipients.length;
    return {
      state: this.state(recipients),
      recipients,
      ...(this.lastAttemptAt ? { lastAttemptAt: this.lastAttemptAt.toISOString() } : {}),
      ...(this.suppressed > 0 ? { suppressed: this.suppressed } : {}),
    };
  }

  /**
   * Raises an alert. Resolves once the attempt is over; never rejects.
   *
   * Awaited by its callers rather than fired and forgotten, so the pass that
   * detected the outage cannot finish — and let the process be reaped — with the
   * message still in a socket. It is already on a background timer; nothing is
   * waiting on it.
   *
   * `urgent` skips `alerts.minInterval` and is for the message that *ends* an
   * alert: an operator who was woken is owed the "it is back" line, and
   * withholding that one to protect the mailbox leaves them chasing an outage that
   * is over. It still records the send, so the next declaration is spaced from it.
   */
  async raise(
    alert: OperatorAlert,
    now: Date = new Date(),
    options: { urgent?: boolean } = {},
  ): Promise<OperatorAlertDelivery | null> {
    if (!this.enabled) {
      return null;
    }
    const recipients = this.recipients;
    if (recipients.length === 0) {
      // Once per raise, at `warn`: the deployment is detecting outages and has
      // nobody to tell, which an operator reading the log can fix in one line of
      // configuration.
      this.logger.warn(
        `Outage alert "${alert.title}" was not sent: neither alerts.emails nor auth.adminEmails names an address.`,
      );
      return null;
    }
    if (!options.urgent && this.withinMinInterval(now)) {
      this.suppressed += 1;
      this.logger.warn(`Outage alert "${alert.title}" suppressed: another was sent less than the alert interval ago.`);
      return null;
    }

    const suppressed = this.suppressed;
    this.lastAttemptAt = now;

    const delivery = await this.send(withSuppressed(alert, suppressed), recipients);
    if (!delivery) {
      return null;
    }
    if (delivery.delivered.length > 0) {
      // The interval is armed by a message that *landed*, not by one that was
      // attempted. A send that reached nobody put nothing in a mailbox, so there
      // is nothing to protect — and arming on failure would spend the next
      // quarter-hour's alerting budget on a message that does not exist, which is
      // the opposite of what this rate limit is for. The per-run latch still stops
      // one outage from sending twice.
      this.lastSentAt = now.getTime();
      this.suppressed = 0;
      this.logger.log(`Outage alert "${alert.title}" delivered to ${delivery.delivered.length} operator(s).`);
    } else {
      this.logger.error(
        `Outage alert "${alert.title}" reached nobody: ${
          delivery.skipped ?? delivery.failed.map((failure) => failure.reason).join(', ')
        }. The outage is in the log and on /admin/health; nothing left this deployment.`,
      );
    }
    return delivery;
  }

  /**
   * Sends one alert now, past the interval and past the latch — the operator's own
   * "does this actually arrive?".
   *
   * It exists because the acceptance criterion for an alerting path is a message
   * that arrived, and the only honest way to produce one on a live deployment is
   * to ask it to send one. Inducing a real outage on production to see whether the
   * mail goes out is the thing that cost us 28 minutes once already.
   */
  async sendTest(raisedBy: string, now: Date = new Date()): Promise<OperatorAlertDelivery> {
    if (!this.enabled) {
      return { attempted: 0, delivered: [], failed: [], skipped: 'no_provider' };
    }
    const recipients = this.recipients;
    if (recipients.length === 0) {
      return { attempted: 0, delivered: [], failed: [], skipped: 'no_recipients' };
    }
    this.lastAttemptAt = now;
    const delivery = await this.send(
      {
        title: 'Alert channel test',
        summary:
          'This is a test of this deployment’s operator alert channel. Nothing is wrong. An external model ' +
          'endpoint that stops serving sends a message that looks like this one.',
        facts: [
          ['Raised by', raisedBy],
          ['Raised at', now.toISOString()],
          ['Recipients', String(recipients.length)],
        ],
        action: 'No action needed. If this arrived, an outage alert will arrive too.',
      },
      recipients,
    );
    return delivery ?? { attempted: recipients.length, delivered: [], failed: [], skipped: null };
  }

  /**
   * The one call that leaves this process, with the guarantee its callers need:
   * it never rejects.
   *
   * `MailService.sendOperatorAlert` already swallows a provider's refusal per
   * address, so what this catches is a programming error in the envelope — and a
   * caller that cannot be allowed to fail must not depend on there being none.
   * A throw here is counted as "reached nobody", which is what it is.
   */
  private async send(alert: OperatorAlert, recipients: readonly string[]): Promise<OperatorAlertDelivery | null> {
    let delivery: OperatorAlertDelivery;
    try {
      delivery = await this.mail.sendOperatorAlert(alert, recipients);
    } catch (error) {
      this.lastDelivered = false;
      this.logger.error(
        `Outage alert "${alert.title}" could not be sent: ${error instanceof Error ? error.message : String(error)}.`,
      );
      return null;
    }
    this.lastDelivered = delivery.delivered.length > 0;
    return delivery;
  }

  private withinMinInterval(now: Date): boolean {
    const interval = this.config.alerts.minInterval;
    return interval > 0 && this.lastSentAt !== null && now.getTime() - this.lastSentAt < interval;
  }

  private state(recipients: number): AlertChannelStatus['state'] {
    if (!this.enabled) {
      return 'disabled';
    }
    if (recipients === 0) {
      return 'unconfigured';
    }
    if (this.lastDelivered === null) {
      return 'ready';
    }
    return this.lastDelivered ? 'ok' : 'failing';
  }
}

/**
 * Says what the interval swallowed, in the message that got through.
 *
 * A suppressed alert that is never mentioned is a suppressed alert nobody knows
 * about, and "this flapped nine more times" is the fact that distinguishes a
 * one-off from an upstream that is rolling.
 */
function withSuppressed(alert: OperatorAlert, suppressed: number): OperatorAlert {
  if (suppressed === 0) {
    return alert;
  }
  return {
    ...alert,
    facts: [...alert.facts, ['Alerts suppressed since the last message', String(suppressed)]],
  };
}
