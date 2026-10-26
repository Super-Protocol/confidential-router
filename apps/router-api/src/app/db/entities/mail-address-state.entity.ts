import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { bigIntColumn, idPrimaryColumn, timestampColumn } from '../columns.js';

/**
 * Where an address stands with the mail provider.
 *
 * - `rejecting` — mail to it is being dropped and will keep being dropped: a
 *   hard bounce, a spam complaint, or a send the provider accepted and then
 *   discarded because the address is on its suppression list. **Nothing in a
 *   send reports this state**, which is the whole reason the table exists.
 * - `delayed` — something non-permanent went wrong: a full mailbox, a
 *   transient refusal, a send the provider itself failed. It will be retried.
 * - `delivering` — the provider last said the message arrived, so whatever was
 *   recorded before is stale.
 */
export type MailAddressStateName = 'rejecting' | 'delayed' | 'delivering';

/** Which event put the address in its current state. See `resend-webhook.ts`. */
export type MailAddressStateReason = 'bounced' | 'complained' | 'suppressed' | 'failed' | 'delayed';

/**
 * One address the mail provider has had something to say about (SUP-551).
 *
 * **A row is only ever created by bad news.** A delivery that worked updates a
 * row that already exists — clearing it — and inserts nothing, so this is a
 * list of addresses with a problem and not a list of everyone the deployment
 * has ever mailed. That is a privacy property as much as a size one: an
 * address here is one the provider already holds on its own suppression list.
 *
 * One row per address rather than an append-only log of every event. The log
 * is the process log, where each event is written at `error` with the
 * provider's own words; what a query needs — the console asking whether this
 * address is reachable, `/admin/health` counting how many are not — is the
 * current state, and deriving that from a log on every read would be a scan to
 * answer a question one row already answers.
 *
 * No FK and no `userId`: an address that bounces usually has no account —
 * SUP-551's own case was a typo of a colleague's address — and Better Auth owns
 * the `user` table anyway (ADR-004 §3). Who holds the address is resolved at
 * read time, for a log line, and never stored here.
 */
@Entity({ name: 'mail_address_states' })
export class MailAddressState {
  @PrimaryColumn(idPrimaryColumn())
  id!: string;

  /**
   * The recipient, lower-cased and with any display name stripped
   * (`normaliseAddress`). Unique: this table holds a state, not a history.
   */
  @Index('IDX_mail_address_states_email', { unique: true })
  @Column({ type: 'varchar', length: 320 })
  email!: string;

  /** Indexed because `/health` counts the `rejecting` rows on every probe. */
  @Index('IDX_mail_address_states_state')
  @Column({ type: 'varchar', length: 16 })
  state!: MailAddressStateName;

  /** Null exactly while `state` is `delivering`. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  reason!: MailAddressStateReason | null;

  /** The provider's own words, clipped. Never shown to the person — it is the operator's. */
  @Column({ type: 'varchar', length: 512, nullable: true })
  detail!: string | null;

  /**
   * The provider's id for the delivery that last changed this row.
   *
   * The idempotency key: a webhook the provider redelivers — which it will, on
   * any response it did not read as 2xx — must not count a second failure for
   * one message. Compared before anything is written.
   */
  @Column({ type: 'varchar', length: 128, nullable: true })
  lastDeliveryId!: string | null;

  /**
   * Messages to this address the provider has reported as not delivered, since
   * the last one that was.
   *
   * The number SUP-551 is about: three people-attempts, three dead ends. A
   * count above one on a `rejecting` row is somebody pressing "send a new code"
   * and getting nothing, which is the shape of a person stuck.
   */
  @Column(bigIntColumn({ default: 0 }))
  failures!: number;

  /** When the provider first had something to say about this address. */
  @Column(timestampColumn())
  firstEventAt!: Date;

  /** When it last did, whatever the event was. */
  @Column(timestampColumn())
  lastEventAt!: Date;

  /** When the address entered `rejecting`; null while it is in any other state. */
  @Column(timestampColumn({ nullable: true }))
  rejectingSince!: Date | null;

  @Column(timestampColumn())
  updatedAt!: Date;
}
