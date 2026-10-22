import { type MigrationInterface, type QueryRunner, Table } from 'typeorm';

const ID = { type: 'varchar', length: '64' } as const;

/**
 * `data_imports` — the deployment exports this deployment has taken (SUP-481).
 *
 * What makes a repeat import of the same dataset legal on a deployment somebody
 * has signed up to since: see `DataImport`.
 *
 * Additive; nothing existing is touched or backfilled. A deployment imported by
 * an older build therefore has no row, and the plan falls back on the row ids it
 * already holds as the evidence of where its data came from.
 */
export class DataImports1760200000000 implements MigrationInterface {
  name = 'DataImports1760200000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'data_imports',
        columns: [
          { name: 'id', ...ID, isPrimary: true },
          { name: 'sourcePublicBaseUrl', type: 'varchar', length: '2048' },
          { name: 'sourceRouterVersion', type: 'varchar', length: '64' },
          { name: 'bundleExportedAt', type: 'bigint' },
          { name: 'contentSha256', ...ID },
          { name: 'importedByUserId', ...ID, isNullable: true },
          { name: 'importedAt', type: 'bigint' },
        ],
        indices: [{ name: 'IDX_data_imports_importedAt', columnNames: ['importedAt'] }],
      }),
      true,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('data_imports', true, true, true);
  }
}
