import { type MigrationInterface, type QueryRunner, TableColumn } from 'typeorm';

/**
 * `invite_codes.issuedByUserId` — the operator who minted a code from the console
 * (SUP-268).
 *
 * Until now the CLI was the only way a code came into existence, and whoever ran
 * it was answerable from the shell they ran it in. The console's issuing form
 * has no such trail, so the account goes on the row, the same way
 * `trusted_measurements.addedByUserId` records who trusted a cloud. An id rather
 * than an address because the address is Better Auth's to change.
 *
 * Additive and nullable. Null means "minted by the CLI", which is true of every
 * row that exists today, so nothing is backfilled.
 */
export class InviteCodeIssuer1759900000000 implements MigrationInterface {
  name = 'InviteCodeIssuer1759900000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'invite_codes',
      new TableColumn({ name: 'issuedByUserId', type: 'varchar', length: '64', isNullable: true }),
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('invite_codes', 'issuedByUserId');
  }
}
