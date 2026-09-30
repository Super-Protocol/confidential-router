import { type MigrationInterface, type QueryRunner, TableColumn } from 'typeorm';

/**
 * `api_keys.purpose` — what a credential was minted for (SUP-180).
 *
 * The console's Chat screen talks to the same `/v1/chat/completions` as any
 * other client, so it needs a real workspace key. Without a marker the console
 * could not tell its own key from the user's, and every visit to the screen
 * would leave another one behind; with it, the screen rotates exactly one key
 * and the Keys table can label it.
 *
 * Nullable with no backfill: every key that exists today was created by a
 * person, and `null` is precisely that statement.
 */
export class ConsoleChatKeys1759100000000 implements MigrationInterface {
  name = 'ConsoleChatKeys1759100000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'api_keys',
      new TableColumn({ name: 'purpose', type: 'varchar', length: '32', isNullable: true }),
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('api_keys', 'purpose');
  }
}
