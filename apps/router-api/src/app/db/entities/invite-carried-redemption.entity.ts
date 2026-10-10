import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn, type Relation } from 'typeorm';
import { idColumn, idPrimaryColumn, timestampColumn } from '../columns.js';
import { InviteCode } from './invite-code.entity.js';

/**
 * A redemption that happened on another deployment, carried here by a codes CSV
 * import (SUP-272).
 *
 * Not an {@link InviteRedemption}, and deliberately so. That row says "this
 * account was credited here": it names a workspace and the ledger entry that paid
 * it, and its unique index is the one-grant-per-account policy. A carried
 * redemption has none of those — the account may not exist on this deployment,
 * and no credit was written to this ledger — so recording it there would mean
 * inventing a ledger id and telling the console a grant landed that never did.
 *
 * What makes the code unredeemable here is `invite_codes.redemptionCount`, which
 * the import sets; this row is only the answer to "who used it, and when". The
 * address is matched to an account at read time, so a person who signs up again
 * after the import is linked without anything being rewritten.
 */
@Entity({ name: 'invite_carried_redemptions' })
export class InviteCarriedRedemption {
  @PrimaryColumn(idPrimaryColumn())
  id!: string;

  @Index('IDX_invite_carried_redemptions_inviteCodeId')
  @Column(idColumn())
  inviteCodeId!: string;

  /** Lower case. Null when the source deployment had already lost the account. */
  @Column({ type: 'varchar', length: 320, nullable: true })
  email!: string | null;

  /** When it was redeemed on the deployment the file came from. */
  @Column(timestampColumn())
  redeemedAt!: Date;

  @Column(timestampColumn())
  importedAt!: Date;

  @ManyToOne(() => InviteCode, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'inviteCodeId' })
  inviteCode?: Relation<InviteCode>;
}
