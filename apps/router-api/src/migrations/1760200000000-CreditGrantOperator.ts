import { type MigrationInterface, type QueryRunner, TableColumn } from 'typeorm';

/**
 * `credit_transactions.grantedByUserId` — the operator behind a ledger entry
 * nobody paid for (SUP-406).
 *
 * Until now every row had a non-human origin on it already: a Stripe object, a
 * generation, an invitation campaign. An operator crediting an account by hand
 * has none, and `description` is the wrong place for the answer — it is the line
 * the Credits screen renders to the *account holder*, and "who granted this" has
 * to survive that text being rewritten. So the account goes on the row, the same
 * way `invite_codes.issuedByUserId` records who minted a code. An id rather than
 * an address because the address is Better Auth's to change.
 *
 * Additive and nullable. Null means "not an operator's doing", which is true of
 * every row that exists today and of every purchase, debit and automatic grant
 * written from here on, so nothing is backfilled.
 */
export class CreditGrantOperator1760200000000 implements MigrationInterface {
  name = 'CreditGrantOperator1760200000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'credit_transactions',
      new TableColumn({ name: 'grantedByUserId', type: 'varchar', length: '64', isNullable: true }),
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('credit_transactions', 'grantedByUserId');
  }
}
