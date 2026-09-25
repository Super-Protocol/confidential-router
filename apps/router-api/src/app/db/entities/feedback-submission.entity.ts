import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn, type Relation } from 'typeorm';
import { bigIntColumn, idColumn, idPrimaryColumn, jsonColumn, timestampColumn } from '../columns.js';
import { Workspace } from './workspace.entity.js';

/**
 * The part of a submission worth keeping: the answers and the questions they
 * refer to, both as the provider sent them.
 *
 * `unknown[]` and not a shape of our own, on purpose. Marketing iterates the
 * questions without a deploy — which is the whole reason the form is not ours —
 * so a type that named them would be wrong by the second revision.
 */
export interface FeedbackAnswers {
  answers: unknown[];
  fields: unknown[];
}

/** Why a verified submission did not earn its credit. */
export type FeedbackRefusalReason = 'already_granted' | 'not_eligible' | 'unknown_account' | 'error';

/**
 * One verified feedback submission, and the second grant it did or did not earn.
 *
 * Every delivery the form provider signs lands here, credited or not, because
 * the answers are the point: the first $100 buys usage and the second buys
 * information, and a question asked through a form we might stop paying for
 * must not take its answers with it when we do (SUP-149).
 *
 * Two of the three locks against a double grant are indices on this table, and
 * neither is a check in application code:
 *
 *  - `submissionId` is unique, so a webhook the provider redelivers — which it
 *    will, on any response it did not read as 2xx — collapses onto the row the
 *    first delivery wrote;
 *  - `grantedUserId` is unique **and nullable**, which is what makes "one
 *    feedback grant per account, ever" a constraint rather than an intention. A
 *    refused submission leaves it null, and a unique index ignores nulls on both
 *    PostgreSQL and SQLite, so the same account may submit again without the
 *    database calling it a duplicate. It duplicates `userId` on the granting row
 *    on purpose: `userId` records who submitted, `grantedUserId` records who was
 *    paid, and only the second one is a policy.
 *
 * The third is the ledger's unique `idempotencyKey`, `feedback:<userId>`, which
 * runs in the same transaction as the insert here.
 *
 * No database foreign key on `userId`: Better Auth owns the `user` table
 * (ADR-004 §3).
 */
@Entity({ name: 'feedback_submissions' })
export class FeedbackSubmission {
  @PrimaryColumn(idPrimaryColumn())
  id!: string;

  /** `typeform` today; the webhook seam is the same for any signed form provider. */
  @Column({ type: 'varchar', length: 32 })
  provider!: string;

  /** The provider's own form identifier, so answers can be read against the right questions. */
  @Column({ type: 'varchar', length: 128, nullable: true })
  formId!: string | null;

  /** The provider's response id. Unique: a redelivery is the same submission. */
  @Index('IDX_feedback_submissions_submissionId', { unique: true })
  @Column({ type: 'varchar', length: 128 })
  submissionId!: string;

  /** Who submitted, from the signed token the console put in the form's hidden fields. */
  @Index('IDX_feedback_submissions_userId')
  @Column(idColumn())
  userId!: string;

  @Column(idColumn())
  workspaceId!: string;

  /** Set only when the credit landed. The unique index on it *is* the one-per-account policy. */
  @Index('IDX_feedback_submissions_grantedUserId', { unique: true })
  @Column(idColumn({ nullable: true }))
  grantedUserId!: string | null;

  @Column(bigIntColumn({ nullable: true }))
  grantMicros!: number | null;

  /** The `grant` ledger row this submission wrote, in the same transaction. */
  @Column(idColumn({ nullable: true }))
  creditTransactionId!: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  refusalReason!: FeedbackRefusalReason | null;

  /** The answers, verbatim. See {@link FeedbackAnswers}. */
  @Column(jsonColumn())
  answers!: FeedbackAnswers;

  @Column(timestampColumn())
  submittedAt!: Date;

  @Column(timestampColumn())
  createdAt!: Date;

  @ManyToOne(() => Workspace, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'workspaceId' })
  workspace?: Relation<Workspace>;
}
