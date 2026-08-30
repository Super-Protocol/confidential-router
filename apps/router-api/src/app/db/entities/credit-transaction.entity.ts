import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn, type Relation } from 'typeorm';
import { bigIntColumn, idColumn, idPrimaryColumn, timestampColumn } from '../columns.js';
import { Workspace } from './workspace.entity.js';

export type CreditTransactionKind = 'purchase' | 'usage' | 'refund' | 'adjustment' | 'auto_topup';

/**
 * Append-only credits ledger. `Workspace.balanceMicros` is its running sum.
 *
 * Append-only is enforced by construction rather than convention: there is no
 * update or delete path in any service, and the schema has no `updatedAt`. A
 * correction is a new row with a negative `amountMicros`, never an edit.
 */
@Entity({ name: 'credit_transactions' })
export class CreditTransaction {
  @PrimaryColumn(idPrimaryColumn())
  id!: string;

  @Index('IDX_credit_transactions_workspaceId')
  @Column(idColumn())
  workspaceId!: string;

  @Column({ type: 'varchar', length: 16 })
  kind!: CreditTransactionKind;

  /** Signed: credits are positive, usage is negative. */
  @Column(bigIntColumn())
  amountMicros!: number;

  /** Stripe object id, generation id, … depending on `kind`. */
  @Column({ type: 'varchar', length: 128, nullable: true })
  reference!: string | null;

  @Column({ type: 'varchar', length: 512, nullable: true })
  description!: string | null;

  /**
   * Makes every write retry-safe: a Stripe webhook redelivery or a retried
   * debit collapses onto the row that already exists instead of double-charging.
   */
  @Index('IDX_credit_transactions_idempotencyKey', { unique: true })
  @Column({ type: 'varchar', length: 128 })
  idempotencyKey!: string;

  @Column(timestampColumn())
  createdAt!: Date;

  @ManyToOne(
    () => Workspace,
    (workspace) => workspace.creditTransactions,
    { onDelete: 'CASCADE' },
  )
  @JoinColumn({ name: 'workspaceId' })
  workspace?: Relation<Workspace>;
}
