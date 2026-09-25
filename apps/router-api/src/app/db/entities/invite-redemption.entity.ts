import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn, type Relation } from 'typeorm';
import { idColumn, idPrimaryColumn, timestampColumn } from '../columns.js';
import { InviteCode } from './invite-code.entity.js';
import { Workspace } from './workspace.entity.js';

/**
 * That an account redeemed an invitation, once and for all.
 *
 * The unique index on `userId` **is** the "one grant per account, ever" policy.
 * A composite unique on `(inviteCodeId, userId)` is deliberately absent: it is
 * implied by this one, and a second index enforcing a weaker rule would only
 * cost a write without ruling anything out. Should the policy ever become "one
 * grant per code per account", the composite replaces this index rather than
 * joining it.
 *
 * No database foreign key on `userId`: Better Auth owns the `user` table and
 * nothing here takes a constraint on it, so the two schemas stay independent
 * (ADR-004 §3).
 *
 * `ipHash` / `userAgentHash` exist so a campaign can be reviewed for abuse —
 * a hundred redemptions from one fingerprint is the pattern worth seeing — and
 * are salted one-way digests, never the values themselves.
 */
@Entity({ name: 'invite_redemptions' })
export class InviteRedemption {
  @PrimaryColumn(idPrimaryColumn())
  id!: string;

  @Index('IDX_invite_redemptions_inviteCodeId')
  @Column(idColumn())
  inviteCodeId!: string;

  @Index('IDX_invite_redemptions_userId', { unique: true })
  @Column(idColumn())
  userId!: string;

  @Column(idColumn())
  workspaceId!: string;

  /** The `grant` ledger row this redemption wrote, in the same transaction. */
  @Column(idColumn())
  creditTransactionId!: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  ipHash!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  userAgentHash!: string | null;

  @Column(timestampColumn())
  redeemedAt!: Date;

  @ManyToOne(
    () => InviteCode,
    (code) => code.redemptions,
    { onDelete: 'CASCADE' },
  )
  @JoinColumn({ name: 'inviteCodeId' })
  inviteCode?: Relation<InviteCode>;

  @ManyToOne(() => Workspace, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'workspaceId' })
  workspace?: Relation<Workspace>;
}
