import { type MigrationInterface, type QueryRunner, TableColumn } from 'typeorm';

/**
 * `endpoints.declaredImages` — the operator's image allow-list for an endpoint,
 * pinned by digest (SUP-190).
 *
 * The console's attestation inspector draws a deployment graph out of the
 * endpoint's *signed* evidence and marks each container's digest. For that mark
 * to mean anything, the thing it is compared against has to come from somewhere
 * the evidence does not: comparing the snapshot with digests derived from the
 * same snapshot is a green tick that proves nothing. This column is that other
 * side — what the operator declares the endpoint runs, which the signed evidence
 * then either matches or does not.
 *
 * Nullable on purpose, and null is not the same as `[]`. Null means the config
 * declares no allow-list, and the console says exactly that rather than painting
 * unchecked images green; `[]` means the endpoint is declared to run nothing, so
 * every image in the evidence is undeclared. Collapsing the two would make a
 * missing declaration read as a clean one.
 *
 * `simple-json` is TEXT on both drivers, like every other structured column
 * here — the schema stays byte-identical on PostgreSQL and SQLite
 * (`docs/contracts/data-model.md`). Existing rows take null and are re-derived
 * from the config at the next boot anyway, so no backfill is needed.
 */
export class EndpointDeclaredImages1759300000000 implements MigrationInterface {
  name = 'EndpointDeclaredImages1759300000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'endpoints',
      new TableColumn({ name: 'declaredImages', type: 'text', isNullable: true }),
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('endpoints', 'declaredImages');
  }
}
