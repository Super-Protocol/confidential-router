import { type MigrationInterface, type QueryRunner, Table } from 'typeorm';

/**
 * Invitation codes and their redemptions (SUP-142).
 *
 * Same rules as the initial schema: TypeORM's dialect-neutral `Table` API so one
 * migration produces an identical schema on PostgreSQL and SQLite, and no
 * foreign key on `user` — Better Auth owns that table (ADR-004 §3).
 *
 * `credit_transactions.kind` gains the value `grant`, which needs no DDL: the
 * column is a `varchar(16)` and the allowed set lives in the entity's union type
 * and in `LedgerService`, not in a database enum.
 */

const ID = { type: 'varchar', length: '64' } as const;

export class InviteCodes1758800000000 implements MigrationInterface {
  name = 'InviteCodes1758800000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'invite_codes',
        columns: [
          { name: 'id', ...ID, isPrimary: true },
          { name: 'code', type: 'varchar', length: '32' },
          { name: 'grantMicros', type: 'bigint' },
          { name: 'campaign', type: 'varchar', length: '64' },
          { name: 'maxRedemptions', type: 'integer', default: 1 },
          { name: 'redemptionCount', type: 'integer', default: 0 },
          { name: 'expiresAt', type: 'bigint', isNullable: true },
          { name: 'disabledAt', type: 'bigint', isNullable: true },
          { name: 'note', type: 'varchar', length: '512', isNullable: true },
          { name: 'createdAt', type: 'bigint' },
        ],
        indices: [
          { name: 'IDX_invite_codes_code', columnNames: ['code'], isUnique: true },
          { name: 'IDX_invite_codes_campaign', columnNames: ['campaign'] },
        ],
      }),
      true,
    );

    await queryRunner.createTable(
      new Table({
        name: 'invite_redemptions',
        columns: [
          { name: 'id', ...ID, isPrimary: true },
          { name: 'inviteCodeId', ...ID },
          { name: 'userId', ...ID },
          { name: 'workspaceId', ...ID },
          { name: 'creditTransactionId', ...ID },
          { name: 'ipHash', type: 'varchar', length: '64', isNullable: true },
          { name: 'userAgentHash', type: 'varchar', length: '64', isNullable: true },
          { name: 'redeemedAt', type: 'bigint' },
        ],
        indices: [
          // The "one grant per account, ever" policy, as a constraint.
          { name: 'IDX_invite_redemptions_userId', columnNames: ['userId'], isUnique: true },
          { name: 'IDX_invite_redemptions_inviteCodeId', columnNames: ['inviteCodeId'] },
        ],
        foreignKeys: [
          {
            columnNames: ['inviteCodeId'],
            referencedTableName: 'invite_codes',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
          },
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
    for (const table of ['invite_redemptions', 'invite_codes']) {
      await queryRunner.dropTable(table, true, true, true);
    }
  }
}
