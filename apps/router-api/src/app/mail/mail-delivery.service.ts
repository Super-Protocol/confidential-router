import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  MailAddressState,
  type MailAddressStateName,
  type MailAddressStateReason,
} from '../db/entities/mail-address-state.entity.js';
import { User } from '../db/entities/user.entity.js';
import { type MailProviderEvent, normaliseAddress } from './resend-webhook.js';

/** What `/health` and `/admin/health` say about addresses the provider is dropping. */
export interface UndeliverableMailStatus {
  /** Addresses currently in `rejecting`: every message to them is being discarded. */
  addresses: number;
  /** When the most recent of those was last reported. Absent while there are none. */
  lastAt?: string;
}

/** The current state of one address, for a caller that asked about it by name. */
export interface MailAddressVerdict {
  state: MailAddressStateName | 'unknown';
  since?: Date;
}

/**
 * What the mail provider knows and the deployment did not (SUP-551).
 *
 * A bounce puts an address on the provider's suppression list, and from then on
 * every message to it is accepted at SMTP time and silently discarded. The send
 * succeeds, `MailService.record()` books a healthy send, and three people-attempts
 * produce three dead ends with no error anywhere in this stack. The outcome
 * exists in exactly one place — the provider's event stream — so this service
 * consumes it and writes it down.
 *
 * Two readers, and they want different things:
 *
 *  - **the operator**, who needs to be told. Every non-delivery is written at
 *    `error` with the provider's own words and whether an account holds the
 *    address, because "an invited stranger mistyped their address" and "a user
 *    of this deployment can no longer sign in" are different emergencies.
 *  - **the person at the code-entry screen**, who is being told the mail is
 *    merely slow while the deployment knows it was rejected. `verdictOf` is
 *    what lets the console stop saying that.
 *
 * Nothing here ever throws at its caller: the webhook is the provider's
 * request, not a user's, and a database that cannot take the row must not turn
 * into a retry storm from the provider — which reads any non-2xx as "send it
 * again for the next few days".
 */
@Injectable()
export class MailDeliveryService {
  private readonly logger = new Logger(MailDeliveryService.name);

  constructor(
    @InjectRepository(MailAddressState) private readonly states: Repository<MailAddressState>,
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {}

  /**
   * Applies one provider event to the address it is about.
   *
   * `deliveryId` is the provider's id for the delivery, and the idempotency
   * key: a redelivery of a message we already applied changes nothing, so the
   * `failures` count stays the count of distinct messages that were dropped
   * rather than of HTTP requests the provider made.
   *
   * Good news clears a row and never creates one. A deployment mails far more
   * addresses than it has trouble with, and a table with a row per recipient
   * would be a list of everyone who ever asked for a code — which this feature
   * has no use for and no business keeping.
   */
  async record(event: MailProviderEvent, deliveryId: string): Promise<void> {
    const email = normaliseAddress(event.email);
    if (email.length === 0) {
      return;
    }
    const next = stateOf(event);

    try {
      const existing = await this.states.findOne({ where: { email } });
      if (existing?.lastDeliveryId === deliveryId) {
        // The same delivery, again. Already applied.
        return;
      }
      if (!existing && next.state === 'delivering') {
        return;
      }
      await this.apply({ email, existing, next, event, deliveryId });
    } catch (error) {
      // The provider gets its 200 regardless — see the class comment.
      this.logger.error(`Could not record a "${event.kind}" mail event: ${messageOf(error)}.`);
      return;
    }

    if (next.state === 'rejecting') {
      this.logger.error(await this.describeRejection(email, event));
    } else if (next.state === 'delayed') {
      this.logger.warn(
        `Mail to ${email} was not delivered (${event.kind}${event.detail ? `: ${event.detail}` : ''}). ` +
          'The provider will retry; no action unless it repeats.',
      );
    }
  }

  /**
   * Where an address stands, for a caller that already holds it.
   *
   * `unknown` is the answer for every address the provider has never complained
   * about, which is almost all of them — including every address that does not
   * exist here. Nothing in this answer depends on whether an account holds the
   * address, which is what makes it safe to give to a visitor who has not
   * signed in: it is a fact about the mailbox, and the same fact the mailbox's
   * own server would give anyone who mailed it.
   */
  async verdictOf(email: string): Promise<MailAddressVerdict> {
    const row = await this.states.findOne({ where: { email: normaliseAddress(email) } });
    if (!row) {
      return { state: 'unknown' };
    }
    return { state: row.state, since: row.rejectingSince ?? row.lastEventAt };
  }

  /** The operator's number: how many addresses this deployment can no longer reach. */
  async undeliverable(): Promise<UndeliverableMailStatus> {
    const [rows, addresses] = await this.states.findAndCount({
      where: { state: 'rejecting' },
      order: { lastEventAt: 'DESC' },
      take: 1,
    });
    const latest = rows[0];
    return { addresses, ...(latest ? { lastAt: latest.lastEventAt.toISOString() } : {}) };
  }

  private async apply(change: {
    email: string;
    existing: MailAddressState | null;
    next: AddressState;
    event: MailProviderEvent;
    deliveryId: string;
  }): Promise<void> {
    const { email, existing, next, event, deliveryId } = change;
    const row =
      existing ?? this.states.create({ id: randomUUID(), email, failures: 0, firstEventAt: event.occurredAt });

    row.state = next.state;
    row.reason = next.reason;
    row.detail = event.detail;
    row.lastDeliveryId = deliveryId;
    // A delivery that worked resets the count: what the operator is being
    // asked to read is "messages dropped since the last one that arrived".
    row.failures = next.state === 'delivering' ? 0 : row.failures + 1;
    row.lastEventAt = event.occurredAt;
    // Held from the first rejection rather than reset by each one: "since
    // when" is what tells an operator whether this started before or after the
    // invitations went out.
    row.rejectingSince = next.state === 'rejecting' ? (row.rejectingSince ?? event.occurredAt) : null;
    row.updatedAt = new Date();

    await this.states.save(row);
  }

  /**
   * The sentence an operator has to read, and the one place this feature says
   * what to do about it.
   *
   * Written at `error` because it is an operational event and not a statistic:
   * the deployment has a person it cannot reach, holding a code worth $100 and
   * a console telling them the mail is on its way. When the operator alert
   * channel from SUP-517 / SUP-535 lands, this is the body it carries — the
   * message is assembled here precisely so that routing it somewhere else is a
   * call and not a rewrite.
   */
  private async describeRejection(email: string, event: MailProviderEvent): Promise<string> {
    const held = await this.holdsAnAccount(email);
    const who = held
      ? 'An account on this deployment holds this address, so that account can no longer be sent a sign-in code ' +
        'and cannot sign in at all.'
      : 'No account here holds this address — a mistyped invitation is the usual cause, and the person who typed ' +
        'it has no way to learn that.';
    return (
      `Mail to ${email} is being dropped by the provider (${event.kind}${event.detail ? `: ${event.detail}` : ''}` +
      `${event.messageId ? `, message ${event.messageId}` : ''}). Every later message to it is accepted at SMTP ` +
      `time and discarded, so nothing in a send will report this again. ${who} ` +
      'Clear the address from the provider’s suppression list once the cause is fixed, or reach the person another way.'
    );
  }

  /**
   * Whether an account holds the address.
   *
   * Through the read-only `user` projection — Better Auth owns the table
   * (ADR-004 §3) — and only ever to write the log line above. The answer is
   * never returned to a caller, because that is the account-existence oracle
   * this codebase keeps refusing to build.
   */
  private async holdsAnAccount(email: string): Promise<boolean> {
    try {
      return (await this.users.countBy({ email })) > 0;
    } catch {
      return false;
    }
  }
}

interface AddressState {
  state: MailAddressStateName;
  reason: MailAddressStateReason | null;
}

/** What an event means for the address's stored state. */
function stateOf(event: MailProviderEvent): AddressState {
  switch (event.kind) {
    case 'delivered':
    case 'unsuppressed':
      return { state: 'delivering', reason: null };
    case 'complained':
      return { state: 'rejecting', reason: 'complained' };
    case 'suppressed':
      return { state: 'rejecting', reason: 'suppressed' };
    case 'bounced':
      // Only a permanent bounce is a verdict on the address: a full mailbox is
      // reported through the same event and will be retried.
      return event.permanent ? { state: 'rejecting', reason: 'bounced' } : { state: 'delayed', reason: 'bounced' };
    case 'failed':
      return { state: 'delayed', reason: 'failed' };
    case 'delayed':
      return { state: 'delayed', reason: 'delayed' };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
