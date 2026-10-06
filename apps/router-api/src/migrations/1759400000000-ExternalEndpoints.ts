import {
  type MigrationInterface,
  type QueryRunner,
  Table,
  TableColumn,
  TableForeignKey,
  TableIndex,
} from 'typeorm';

/**
 * External model endpoints — the schema half of ADR-008.
 *
 * Three new tables and five new columns, which together say: a model may live in
 * another deployment, this router verifies that deployment before proxying to it,
 * and the verdict it reaches is display state with a history — never trust.
 *
 * One thing is deliberately *loosened*: `models.endpointId` becomes nullable,
 * because an external model has no endpoint of this router's to point at, and
 * `models.externalEndpointId` takes its place — exclusively. The exclusivity is
 * enforced in `db/entities/invariants.spec.ts` rather than by a CHECK constraint:
 * TypeORM's schema comparison does not track checks identically on PostgreSQL and
 * SQLite, and `migrations.spec.ts` proves the migrated schema matches the entities
 * by requiring that comparison to come back empty.
 *
 * `generations` and `evidence_snapshots` gain their `externalEndpointId` as a
 * plain additive column and keep `endpointId` as it was. Nothing writes an
 * external row through either table yet — the egress leg and the external
 * evidence poll are later stages — and the column those stages will need to
 * discriminate on is the one being added here. Relaxing `endpointId` belongs to
 * whichever of them first has a row that needs it, together with the console
 * fields that read it as non-null today.
 *
 * Same rules as every migration before it: the dialect-neutral `Table` API, no
 * foreign key on `user` (Better Auth owns it, ADR-004 §3), and timestamps as
 * epoch-millisecond `bigint`.
 */

const ID = { type: 'varchar', length: '64' } as const;

/**
 * SQLite has no boolean literal and TypeORM's SQLite driver normalises entity
 * defaults to `1`/`0`, so the migration has to emit the driver's own form to stay
 * byte-identical to the schema the entities describe — the same helper, and the
 * same reason, as `InitialSchema`.
 */
function bool(queryRunner: QueryRunner, value: boolean): string {
  const isSqlite = queryRunner.connection.options.type.includes('sqlite');
  if (isSqlite) {
    return value ? '1' : '0';
  }
  return value ? 'true' : 'false';
}

/**
 * Drops (or restores) a column's NOT NULL without disturbing what points at it.
 *
 * PostgreSQL has the one-line form, and `changeColumn` does *not* use it: it
 * rebuilds the column and silently takes the dependent indices and foreign keys
 * with it, which `migrations.spec.ts` catches as five lines of DDL the entities
 * still expect. SQLite has no `ALTER COLUMN` at all, so there the table rebuild
 * `changeColumn` performs is the only way — and it carries the indices across.
 */
async function setNotNull(queryRunner: QueryRunner, table: string, column: string, notNull: boolean): Promise<void> {
  if (queryRunner.connection.options.type.includes('sqlite')) {
    await queryRunner.changeColumn(table, column, new TableColumn({ name: column, ...ID, isNullable: !notNull }));
    return;
  }
  await queryRunner.query(
    `ALTER TABLE "${table}" ALTER COLUMN "${column}" ${notNull ? 'SET' : 'DROP'} NOT NULL`,
  );
}

export class ExternalEndpoints1759400000000 implements MigrationInterface {
  name = 'ExternalEndpoints1759400000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'external_endpoints',
        columns: [
          { name: 'id', ...ID, isPrimary: true },
          { name: 'name', type: 'varchar', length: '64' },
          { name: 'baseUrl', type: 'varchar', length: '2048' },
          { name: 'hostname', type: 'varchar', length: '255' },
          { name: 'listenPort', type: 'integer' },
          { name: 'enabled', type: 'boolean', default: bool(queryRunner, true) },
          // Every row starts unverified and returns there on every boot: the
          // sidecar re-attests from nothing (ADR-008 §8).
          { name: 'status', type: 'varchar', length: '16', default: "'pending'" },
          { name: 'lastCheckedAt', type: 'bigint', isNullable: true },
          { name: 'lastStage', type: 'varchar', length: '32', isNullable: true },
          { name: 'lastReason', type: 'varchar', length: '255', isNullable: true },
          { name: 'measurementSeen', type: 'varchar', length: '64', isNullable: true },
          { name: 'measurementSource', type: 'varchar', length: '32', isNullable: true },
          { name: 'evidenceDigestSeen', type: 'varchar', length: '128', isNullable: true },
          { name: 'pinnedCertFingerprint', type: 'varchar', length: '128', isNullable: true },
          // AES-256-GCM envelope, never the plaintext. Bounded rather than TEXT
          // so the column cannot quietly become somewhere to put a blob.
          { name: 'apiKeyCiphertext', type: 'varchar', length: '1024' },
          { name: 'apiKeyPrefix', type: 'varchar', length: '16' },
          { name: 'createdByUserId', ...ID, isNullable: true },
          { name: 'createdAt', type: 'bigint' },
          { name: 'updatedAt', type: 'bigint' },
        ],
        indices: [{ name: 'IDX_external_endpoints_name', columnNames: ['name'], isUnique: true }],
      }),
      true,
    );

    await queryRunner.createTable(
      new Table({
        name: 'trusted_measurements',
        columns: [
          { name: 'id', ...ID, isPrimary: true },
          { name: 'measurement', type: 'varchar', length: '64' },
          { name: 'note', type: 'varchar', length: '255', isNullable: true },
          { name: 'addedByUserId', ...ID, isNullable: true },
          { name: 'addedAt', type: 'bigint' },
        ],
        indices: [
          // The list is a set: a measurement is trusted or it is not, and a
          // second pin of the same value is not a second reason.
          { name: 'IDX_trusted_measurements_measurement', columnNames: ['measurement'], isUnique: true },
        ],
      }),
      true,
    );

    await queryRunner.createTable(
      new Table({
        name: 'external_endpoint_events',
        columns: [
          { name: 'id', ...ID, isPrimary: true },
          { name: 'externalEndpointId', ...ID },
          { name: 'at', type: 'bigint' },
          { name: 'kind', type: 'varchar', length: '32' },
          { name: 'stage', type: 'varchar', length: '32', isNullable: true },
          { name: 'reason', type: 'varchar', length: '255', isNullable: true },
          { name: 'measurement', type: 'varchar', length: '64', isNullable: true },
          { name: 'evidenceDigest', type: 'varchar', length: '128', isNullable: true },
        ],
        indices: [
          {
            name: 'IDX_external_endpoint_events_endpointId_at',
            columnNames: ['externalEndpointId', 'at'],
          },
        ],
        foreignKeys: [
          {
            columnNames: ['externalEndpointId'],
            referencedTableName: 'external_endpoints',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
          },
        ],
      }),
      true,
    );

    // `models`: one catalogue table, two origins. Existing rows are config rows,
    // which is what the default says, and they are re-projected at the next boot
    // anyway — so no backfill.
    await queryRunner.addColumn(
      'models',
      new TableColumn({ name: 'origin', type: 'varchar', length: '16', default: "'config'" }),
    );
    await queryRunner.addColumn('models', new TableColumn({ name: 'externalEndpointId', ...ID, isNullable: true }));
    await setNotNull(queryRunner, 'models', 'endpointId', false);
    await queryRunner.createIndex(
      'models',
      new TableIndex({ name: 'IDX_models_externalEndpointId', columnNames: ['externalEndpointId'] }),
    );
    await queryRunner.createForeignKey(
      'models',
      new TableForeignKey({
        columnNames: ['externalEndpointId'],
        referencedTableName: 'external_endpoints',
        referencedColumnNames: ['id'],
        // RESTRICT, like `models.endpointId`: a catalogue row outlives the
        // config that made it so a generation keeps resolving, and deleting the
        // endpoint under it would break that.
        onDelete: 'RESTRICT',
      }),
    );

    await queryRunner.addColumn(
      'generations',
      new TableColumn({ name: 'externalEndpointId', ...ID, isNullable: true }),
    );

    await queryRunner.addColumn(
      'evidence_snapshots',
      new TableColumn({ name: 'externalEndpointId', ...ID, isNullable: true }),
    );
    await queryRunner.createIndex(
      'evidence_snapshots',
      new TableIndex({ name: 'IDX_evidence_snapshots_externalEndpointId', columnNames: ['externalEndpointId'] }),
    );
    await queryRunner.createForeignKey(
      'evidence_snapshots',
      new TableForeignKey({
        columnNames: ['externalEndpointId'],
        referencedTableName: 'external_endpoints',
        referencedColumnNames: ['id'],
        onDelete: 'CASCADE',
      }),
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('evidence_snapshots', 'externalEndpointId');
    await queryRunner.dropColumn('generations', 'externalEndpointId');

    await queryRunner.dropColumn('models', 'externalEndpointId');
    await queryRunner.dropColumn('models', 'origin');
    await setNotNull(queryRunner, 'models', 'endpointId', true);

    // Events first: the foreign key points that way.
    await queryRunner.dropTable('external_endpoint_events', true);
    await queryRunner.dropTable('trusted_measurements', true);
    await queryRunner.dropTable('external_endpoints', true);
  }
}
