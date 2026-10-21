import { type MigrationInterface, type QueryRunner, TableColumn } from 'typeorm';

/**
 * `generations.client` — which client sent the request, as a closed set
 * (SUP-466).
 *
 * The one dimension the meter was missing. SUP-447 took two days to establish
 * which editor a tester was using, from screenshots, while the answer sat in a
 * `User-Agent` on every one of his requests; behaviour differs sharply between
 * VS Code's own chat, Cline, Roo Code, Continue, Cursor and the terminal agents,
 * and some of them fail in ways the user never reports.
 *
 * `varchar(32)`, not the agent string. The closed set is in
 * `generation.entity.ts` and the mapping in `client-dimension.ts`; what lands in
 * this column is a label with no version, no operating system and no editor
 * build in it, because the raw `User-Agent` is a fingerprinting vector that this
 * schema already refuses to store — `invite_redemptions.userAgentHash` keeps a
 * salted hash and nothing else.
 *
 * Additive and nullable, and nothing is backfilled: the requests served before
 * this column existed were never classified, and null says exactly that. Every
 * row written from here on carries a label, `other` included.
 */
export class GenerationClient1760200000000 implements MigrationInterface {
  name = 'GenerationClient1760200000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'generations',
      new TableColumn({ name: 'client', type: 'varchar', length: '32', isNullable: true }),
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('generations', 'client');
  }
}
