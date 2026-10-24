import { type MigrationInterface, type QueryRunner, TableColumn, TableIndex } from 'typeorm';

/**
 * Makes the evidence retention window enforceable (SUP-498).
 *
 * `UserPreferences.evidenceRetentionDays` has been stored, bounded and settable
 * from the console since the initial schema, and `/privacy` publishes it as a
 * period — "the raw bundle for as long as your Preferences say (90 days by
 * default); the digests are kept". Nothing read it. The two columns it was
 * documented to govern were `NOT NULL`, so nothing *could*: there was no way to
 * remove a bundle short of deleting the row, and the row is what carries the
 * digests the same sentence promises to keep.
 *
 * So both come off `NOT NULL`, and `payloadStrippedAt` records when the sweep
 * took them. Null in `jws`/`bundle` therefore has one meaning and one only — the
 * retention window closed on this publication — which is what lets a reader tell
 * a kept promise from a parser that filed an empty row.
 *
 * `IDX_evidence_snapshots_retention` is the sweep's own index — "the oldest rows
 * that still have a payload". It leads on `payloadStrippedAt` so that a row the
 * sweep has emptied drops out of the range for good, which is what makes the pass
 * cheaper every time rather than a growing scan.
 *
 * Two more go on `generations`, for the step after the candidate read: see
 * {@link HOLDER_INDEXES}. The sweep's cost is three parts — find the candidates,
 * ask who holds them, empty the ones nobody does — and only the first and third
 * were covered.
 *
 * Nothing is backfilled and nothing is deleted here: the first pass of
 * `EvidenceRetentionService` after this migration decides what is past its
 * window, under the preference of every account that holds it. A migration that
 * swept on its own would do it once, in a transaction, with no log and no
 * operator looking.
 */
async function setNullable(
  queryRunner: QueryRunner,
  table: string,
  column: string,
  type: string,
  nullable: boolean,
): Promise<void> {
  // The same split, and the same reason, as `ExternalEndpointEvidence1759600000000`:
  // PostgreSQL has the one-line form and `changeColumn` does not use it — it
  // rebuilds the column and takes the dependent indices with it. SQLite has no
  // `ALTER COLUMN`, so there the rebuild is the only way, and it carries the
  // indices across.
  if (queryRunner.connection.options.type.includes('sqlite')) {
    await queryRunner.changeColumn(table, column, new TableColumn({ name: column, type, isNullable: nullable }));
    return;
  }
  await queryRunner.query(
    `ALTER TABLE "${table}" ALTER COLUMN "${column}" ${nullable ? 'DROP' : 'SET'} NOT NULL`,
  );
}

const RETENTION_INDEX = new TableIndex({
  name: 'IDX_evidence_snapshots_retention',
  columnNames: ['payloadStrippedAt', 'issuedAt'],
});

/**
 * The holder lookup's indexes, one per way a generation names its publication.
 *
 * `windowDaysOf` runs two queries per candidate batch — `evidenceSnapshotId IN
 * (…)` for this deployment's own endpoints and `(externalEndpointId,
 * evidenceDigest)` for an upstream's — and `generations` had indexes only on
 * `workspaceId` and `(workspaceId, createdAt)`, neither of which either
 * predicate can use. So each batch sequentially scanned the fastest-growing
 * table in the schema. The candidate read is indexed by
 * {@link RETENTION_INDEX} and the write is capped per pass; this is the step in
 * between, and it is the one that scales with request volume rather than with
 * publication count.
 *
 * Sized for the `archiveEvidence` opt-out (SUP-525), which is what makes the
 * cost permanent rather than occasional: with one opted-out account anywhere the
 * candidate range is every unstripped snapshot on every pass, because no row is
 * too young to be past nobody's window.
 *
 * `workspaceId` is deliberately *not* carried as a third column to make the
 * scans index-only. `generations` takes one insert per completion — it is the
 * hottest write path there is — and two extra indexes on it are already a real
 * cost; widening them to spare a heap fetch on a query that runs four times a
 * day is the wrong side of that trade.
 */
const HOLDER_INDEXES = [
  new TableIndex({ name: 'IDX_generations_evidenceSnapshotId', columnNames: ['evidenceSnapshotId'] }),
  new TableIndex({
    name: 'IDX_generations_externalEndpointId_evidenceDigest',
    columnNames: ['externalEndpointId', 'evidenceDigest'],
  }),
];

export class EvidenceRetentionSweep1760200000000 implements MigrationInterface {
  name = 'EvidenceRetentionSweep1760200000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'evidence_snapshots',
      new TableColumn({ name: 'payloadStrippedAt', type: 'bigint', isNullable: true }),
    );
    // Before the NOT NULLs come off, so the SQLite rebuild of `jws` and `bundle`
    // carries the finished index set across in one pass rather than three.
    await queryRunner.createIndex('evidence_snapshots', RETENTION_INDEX);
    await setNullable(queryRunner, 'evidence_snapshots', 'jws', 'text', true);
    await setNullable(queryRunner, 'evidence_snapshots', 'bundle', 'text', true);
    // On `generations`, so untouched by the SQLite rebuilds above.
    for (const index of HOLDER_INDEXES) {
      await queryRunner.createIndex('generations', index);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const rows = (await queryRunner.query(
      'SELECT COUNT(*) AS "swept" FROM "evidence_snapshots" WHERE "jws" IS NULL OR "bundle" IS NULL',
    )) as { swept: number | string }[];
    const swept = Number(rows[0]?.swept ?? 0);
    if (swept > 0) {
      // Deleting them would restore the constraint, and it would also delete the
      // digest history of every publication whose bundle was lawfully removed —
      // the half of the row `/privacy` promises to keep. Reverting past a
      // retention promise already acted on is a decision for whoever is reverting,
      // not for a `down()` nobody read.
      throw new Error(
        `Cannot restore NOT NULL on evidence_snapshots.jws/bundle: the retention sweep has stripped ${swept} ` +
          'snapshot(s), and the rows still carry the digests the policy keeps. Decide what happens to them first.',
      );
    }
    for (const index of HOLDER_INDEXES) {
      await queryRunner.dropIndex('generations', index);
    }
    await setNullable(queryRunner, 'evidence_snapshots', 'bundle', 'text', false);
    await setNullable(queryRunner, 'evidence_snapshots', 'jws', 'text', false);
    await queryRunner.dropIndex('evidence_snapshots', RETENTION_INDEX);
    await queryRunner.dropColumn('evidence_snapshots', 'payloadStrippedAt');
  }
}
