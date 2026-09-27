import { Column, Entity, Index, OneToMany, PrimaryColumn, type Relation } from 'typeorm';
import { bigIntColumn, idPrimaryColumn, timestampColumn } from '../columns.js';
import { InviteRedemption } from './invite-redemption.entity.js';

/**
 * One mailed invitation: a code that turns into a credit grant the first time
 * an account is created with it.
 *
 * `code` is stored **normalised** — upper case, separators removed — and the
 * lookup normalises its input the same way. That is what makes the match
 * case-insensitive as a plain unique-index hit, rather than needing PostgreSQL's
 * `citext` or SQLite's `COLLATE NOCASE`; neither is available on both databases
 * (`docs/contracts/data-model.md`).
 *
 * `redemptionCount` is a counter and not a `COUNT(*)` over the redemptions
 * because it is the thing the claim races on: one relative `UPDATE … WHERE
 * redemptionCount < maxRedemptions` is what makes two simultaneous sign-ups on
 * the last seat resolve to exactly one grant.
 */
@Entity({ name: 'invite_codes' })
export class InviteCode {
  @PrimaryColumn(idPrimaryColumn())
  id!: string;

  /** Normalised form: `INVITE_CODE_ALPHABET` characters only, no separators. */
  @Index('IDX_invite_codes_code', { unique: true })
  @Column({ type: 'varchar', length: 32 })
  code!: string;

  /** What redeeming it credits, in micro-USD. $100 is `100000000`. */
  @Column(bigIntColumn())
  grantMicros!: number;

  /** Free-text campaign tag, e.g. `launch-2026-10-devs`. Carries the attribution. */
  @Index('IDX_invite_codes_campaign')
  @Column({ type: 'varchar', length: 64 })
  campaign!: string;

  @Column({ type: 'integer', default: 1 })
  maxRedemptions!: number;

  @Column({ type: 'integer', default: 0 })
  redemptionCount!: number;

  @Column(timestampColumn({ nullable: true }))
  expiresAt!: Date | null;

  /**
   * When an operator withdrew the code. `InviteWithdrawalService` is the only
   * writer; `claimSeat` re-checks it inside the redemption transaction, which is
   * why setting it stops the next sign-up without touching any grant already made.
   */
  @Column(timestampColumn({ nullable: true }))
  disabledAt!: Date | null;

  @Column({ type: 'varchar', length: 512, nullable: true })
  note!: string | null;

  @Column(timestampColumn())
  createdAt!: Date;

  @OneToMany(
    () => InviteRedemption,
    (redemption) => redemption.inviteCode,
  )
  redemptions?: Relation<InviteRedemption[]>;
}
