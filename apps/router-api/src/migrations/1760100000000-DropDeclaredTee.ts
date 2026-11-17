import { type MigrationInterface, type QueryRunner, TableColumn } from 'typeorm';

/**
 * Drops `endpoints.tee` and `models.tee`, the operator-declared TEE label
 * (SUP-260).
 *
 * The label was a string from the router config — the chart rendered one default
 * for every deployment, so a router on an AMD SEV-SNP VM printed "Intel TDX +
 * H100 CC" beside evidence that said otherwise. Since SUP-270 the console reads
 * the TEE off the root certificate of the published evidence instead, and with
 * SUP-260 so does every other surface (`Model.tee`, `GET /v1/models`, the chat
 * inspector). Nothing reads these columns any more, and a column nobody reads
 * that contradicts a value everybody does is worse than no column.
 *
 * Not nullable-and-kept: the config key that fed it is ignored from the same
 * build on, so the rows would hold the stale label forever. `down` restores the
 * columns with an empty default, which is what the rows of an external model
 * always held.
 */
export class DropDeclaredTee1760100000000 implements MigrationInterface {
  name = 'DropDeclaredTee1760100000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('models', 'tee');
    await queryRunner.dropColumn('endpoints', 'tee');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'endpoints',
      new TableColumn({ name: 'tee', type: 'varchar', length: '128', default: "''" }),
    );
    await queryRunner.addColumn('models', new TableColumn({ name: 'tee', type: 'varchar', length: '128', default: "''" }));
  }
}
