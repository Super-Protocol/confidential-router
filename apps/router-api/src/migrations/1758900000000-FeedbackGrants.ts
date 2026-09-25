import { type MigrationInterface, type QueryRunner, Table } from 'typeorm';

/**
 * Feedback submissions and the second grant they earn (SUP-149).
 *
 * Same rules as every migration before it: TypeORM's dialect-neutral `Table`
 * API so PostgreSQL and SQLite get an identical schema, and no foreign key on
 * `user` — Better Auth owns that table (ADR-004 §3).
 *
 * The two unique indices are the policy. `submissionId` makes a redelivered
 * webhook idempotent; `grantedUserId` is nullable and unique, which allows a
 * refused submission to be stored while still permitting exactly one credited
 * one per account, because a unique index ignores nulls on both drivers.
 */

const ID = { type: 'varchar', length: '64' } as const;

export class FeedbackGrants1758900000000 implements MigrationInterface {
  name = 'FeedbackGrants1758900000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'feedback_submissions',
        columns: [
          { name: 'id', ...ID, isPrimary: true },
          { name: 'provider', type: 'varchar', length: '32' },
          { name: 'formId', type: 'varchar', length: '128', isNullable: true },
          { name: 'submissionId', type: 'varchar', length: '128' },
          { name: 'userId', ...ID },
          { name: 'workspaceId', ...ID },
          { name: 'grantedUserId', ...ID, isNullable: true },
          { name: 'grantMicros', type: 'bigint', isNullable: true },
          { name: 'creditTransactionId', ...ID, isNullable: true },
          { name: 'refusalReason', type: 'varchar', length: '32', isNullable: true },
          { name: 'answers', type: 'text' },
          { name: 'submittedAt', type: 'bigint' },
          { name: 'createdAt', type: 'bigint' },
        ],
        indices: [
          // A provider redelivery is the same submission, not a second one.
          { name: 'IDX_feedback_submissions_submissionId', columnNames: ['submissionId'], isUnique: true },
          // "One feedback grant per account, ever", as a constraint.
          { name: 'IDX_feedback_submissions_grantedUserId', columnNames: ['grantedUserId'], isUnique: true },
          { name: 'IDX_feedback_submissions_userId', columnNames: ['userId'] },
        ],
        foreignKeys: [
          {
            columnNames: ['workspaceId'],
            referencedTableName: 'workspaces',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
          },
        ],
      }),
      true,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('feedback_submissions', true, true, true);
  }
}
