import { Column, Entity, Index, OneToMany, PrimaryColumn, type Relation } from 'typeorm';
import { bigIntColumn, idPrimaryColumn, timestampColumn } from '../columns.js';
import { ApiKey } from './api-key.entity.js';
import { CreditTransaction } from './credit-transaction.entity.js';
import { Generation } from './generation.entity.js';
import { WorkspaceMember } from './workspace-member.entity.js';

/** Billing and tenancy unit. Every user gets a personal one on first login. */
@Entity({ name: 'workspaces' })
export class Workspace {
  @PrimaryColumn(idPrimaryColumn())
  id!: string;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Index('IDX_workspaces_slug', { unique: true })
  @Column({ type: 'varchar', length: 64 })
  slug!: string;

  /**
   * Cached sum of `credit_transactions.amountMicros`. The ledger is the source
   * of truth; this column exists so the console does not aggregate the whole
   * ledger on every page load, and is only ever written in the same transaction
   * as the ledger row that changed it.
   */
  @Column(bigIntColumn({ default: 0 }))
  balanceMicros!: number;

  @Column({ type: 'varchar', length: 255, nullable: true })
  stripeCustomerId!: string | null;

  @Column({ type: 'boolean', default: false })
  autoTopUpEnabled!: boolean;

  @Column(bigIntColumn({ nullable: true }))
  autoTopUpThresholdMicros!: number | null;

  @Column(bigIntColumn({ nullable: true }))
  autoTopUpAmountMicros!: number | null;

  @Column(timestampColumn({ nullable: true }))
  autoTopUpLastAt!: Date | null;

  @Column(timestampColumn())
  createdAt!: Date;

  @OneToMany(
    () => WorkspaceMember,
    (member) => member.workspace,
  )
  members?: Relation<WorkspaceMember[]>;

  @OneToMany(
    () => ApiKey,
    (key) => key.workspace,
  )
  apiKeys?: Relation<ApiKey[]>;

  @OneToMany(
    () => Generation,
    (generation) => generation.workspace,
  )
  generations?: Relation<Generation[]>;

  @OneToMany(
    () => CreditTransaction,
    (transaction) => transaction.workspace,
  )
  creditTransactions?: Relation<CreditTransaction[]>;
}
