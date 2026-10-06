import { type MigrationInterface, type QueryRunner, TableColumn, TableIndex } from 'typeorm';

/**
 * `evidence_snapshots` starts holding an external upstream's bundles too — the
 * third and last column ADR-008 §6 said would be loosened by the stage that
 * first has a row needing it.
 *
 * Two changes, and they go together:
 *
 *  - **`endpointId` becomes nullable.** A bundle an external upstream published
 *    has no `endpoints` row to point at, and writing the external endpoint's id
 *    into `endpointId` instead would file another operator's publications under
 *    one of ours — the console's per-endpoint digest history reads exactly that
 *    column. `externalEndpointId` carries it, exclusively
 *    (`evidenceSnapshotEndpointIsExclusive`, checked in `invariants.spec.ts`).
 *  - **A second unique identity index.** The existing one is
 *    `(endpointId, evidenceDigest, certFingerprint, issuedAt)`, which is what
 *    makes the poller replica-safe without leader election (ADR-002). It cannot
 *    cover the new rows: both drivers treat NULLs in a unique index as distinct,
 *    so with `endpointId` null it would never collide and every poll would append
 *    a duplicate. The external rows get the same key over their own
 *    discriminator, and each index is inert for the other origin's rows.
 *
 * `workloads` is additive and nullable: the Kubernetes workloads the canonical
 * snapshot declares, parsed on the way in like `containerImages` beside it. Null
 * means "filed before this column existed", which the console has to be able to
 * tell from "the producer declares none" (SUP-221 ruling 1 renders both, and
 * differently).
 *
 * Nothing is backfilled. Every existing row was published by one of this
 * router's own endpoints and keeps its id; `workloads` stays null until that
 * bundle is published again, at which point the poller refreshes the row.
 */
const ID = { type: 'varchar', length: '64' } as const;

const EXTERNAL_IDENTITY = new TableIndex({
  name: 'IDX_evidence_snapshots_external_identity',
  columnNames: ['externalEndpointId', 'evidenceDigest', 'certFingerprint', 'issuedAt'],
  isUnique: true,
});

/**
 * Drops (or restores) a column's NOT NULL without disturbing what points at it.
 *
 * The same helper, and the same reasoning, as `ExternalGenerationEndpoint1759500000000`:
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

export class ExternalEndpointEvidence1759600000000 implements MigrationInterface {
  name = 'ExternalEndpointEvidence1759600000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'evidence_snapshots',
      new TableColumn({ name: 'workloads', type: 'text', isNullable: true }),
    );
    // Before the NOT NULL comes off, so the SQLite rebuild carries the finished
    // index set across in one pass rather than two.
    await queryRunner.createIndex('evidence_snapshots', EXTERNAL_IDENTITY);
    await setNotNull(queryRunner, 'evidence_snapshots', 'endpointId', false);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const rows = (await queryRunner.query(
      'SELECT COUNT(*) AS "orphans" FROM "evidence_snapshots" WHERE "endpointId" IS NULL',
    )) as { orphans: number | string }[];
    const orphans = Number(rows[0]?.orphans ?? 0);
    if (orphans > 0) {
      // Deleting them would be defensible — a snapshot is a cache of something
      // the upstream publishes, not a billing record — but it would also delete
      // the only copy of a bundle a user may have been shown, and reverting past
      // ADR-008 §6 is a decision that should be made deliberately rather than by
      // a `down()` nobody read.
      throw new Error(
        `Cannot restore NOT NULL on evidence_snapshots.endpointId: ${orphans} snapshot(s) were published by an ` +
          'external upstream and have none. Reverting past ADR-008 §6 means deciding what to do with them first.',
      );
    }
    await setNotNull(queryRunner, 'evidence_snapshots', 'endpointId', true);
    await queryRunner.dropIndex('evidence_snapshots', EXTERNAL_IDENTITY);
    await queryRunner.dropColumn('evidence_snapshots', 'workloads');
  }
}
