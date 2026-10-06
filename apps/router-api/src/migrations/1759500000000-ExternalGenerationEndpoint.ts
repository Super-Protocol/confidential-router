import { type MigrationInterface, type QueryRunner, TableColumn } from 'typeorm';

/**
 * `generations.endpointId` becomes nullable — the one column ADR-008's egress leg
 * needs loosened, and the stage that loosens it is the first one with a row that
 * needs it (`ExternalEndpoints1759400000000` said so and left it).
 *
 * A generation served through an external endpoint has no `endpoints` row to point
 * at. Writing the external endpoint's id into `endpointId` instead was the
 * alternative and is worse on both counts the schema cares about: the two tables
 * are separate namespaces precisely so "a host we publish evidence for" cannot be
 * confused with "a host we verified", and the per-endpoint token totals the console
 * groups out of this column would silently start including another operator's
 * traffic. So `externalEndpointId` carries it, exclusively —
 * `generationEndpointIsExclusive`, checked in `invariants.spec.ts`.
 *
 * Nothing is backfilled and nothing can be: every existing row went to a config
 * endpoint and keeps its id. The reverse direction is therefore safe as long as no
 * external generation has been recorded, and refuses rather than deleting one if it
 * has.
 */
const ID = { type: 'varchar', length: '64' } as const;

/**
 * Drops (or restores) a column's NOT NULL without disturbing what points at it.
 *
 * The same helper, and the same reasoning, as `ExternalEndpoints1759400000000`:
 * PostgreSQL has the one-line form and `changeColumn` does not use it — it rebuilds
 * the column and takes the dependent indices with it, which `migrations.spec.ts`
 * catches. SQLite has no `ALTER COLUMN`, so there the rebuild is the only way and
 * it carries the indices across.
 */
async function setNotNull(queryRunner: QueryRunner, table: string, column: string, notNull: boolean): Promise<void> {
  if (queryRunner.connection.options.type.includes('sqlite')) {
    await queryRunner.changeColumn(table, column, new TableColumn({ name: column, ...ID, isNullable: !notNull }));
    return;
  }
  await queryRunner.query(`ALTER TABLE "${table}" ALTER COLUMN "${column}" ${notNull ? 'SET' : 'DROP'} NOT NULL`);
}

export class ExternalGenerationEndpoint1759500000000 implements MigrationInterface {
  name = 'ExternalGenerationEndpoint1759500000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await setNotNull(queryRunner, 'generations', 'endpointId', false);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const rows = (await queryRunner.query(
      'SELECT COUNT(*) AS "orphans" FROM "generations" WHERE "endpointId" IS NULL',
    )) as { orphans: number | string }[];
    const orphans = Number(rows[0]?.orphans ?? 0);
    if (orphans > 0) {
      // Refusing beats inventing an endpoint id or deleting a metered request: a
      // generation is a billing record, and the ledger has already been debited
      // against it.
      throw new Error(
        `Cannot restore NOT NULL on generations.endpointId: ${orphans} generation(s) were served through an ` +
          'external endpoint and have none. Reverting past ADR-008 means deciding what to do with them first.',
      );
    }
    await setNotNull(queryRunner, 'generations', 'endpointId', true);
  }
}
