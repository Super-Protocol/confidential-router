import { type MigrationInterface, type QueryRunner, Table } from 'typeorm';

const ID = { type: 'varchar', length: '64' } as const;

/**
 * `invite_carried_redemptions` — who redeemed a code on the deployment a codes
 * CSV was exported from (SUP-272).
 *
 * A table of its own rather than nullable columns on `invite_redemptions`: that
 * table's rows each name a workspace and a ledger entry on *this* deployment,
 * and a carried redemption has neither. See `InviteCarriedRedemption`.
 *
 * Additive; nothing existing is touched or backfilled.
 */
export class InviteCarriedRedemptions1760000000000 implements MigrationInterface {
  name = 'InviteCarriedRedemptions1760000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'invite_carried_redemptions',
        columns: [
          { name: 'id', ...ID, isPrimary: true },
          { name: 'inviteCodeId', ...ID },
          { name: 'email', type: 'varchar', length: '320', isNullable: true },
          { name: 'redeemedAt', type: 'bigint' },
          { name: 'importedAt', type: 'bigint' },
        ],
        indices: [{ name: 'IDX_invite_carried_redemptions_inviteCodeId', columnNames: ['inviteCodeId'] }],
        foreignKeys: [
          {
            columnNames: ['inviteCodeId'],
            referencedTableName: 'invite_codes',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
          },
        ],
      }),
      true,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('invite_carried_redemptions', true, true, true);
  }
}
