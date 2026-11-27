import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSource, type QueryRunner, type TableColumn } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../../migrations/index.js';
import { buildDataSourceOptions } from './data-source.js';
import { ExternalEndpoint } from './entities/external-endpoint.entity.js';
import { ExternalEndpointEvent } from './entities/external-endpoint-event.entity.js';

/**
 * The migration is hand-written against TypeORM's dialect-neutral `Table` API,
 * so the thing that can go wrong is drift from the entities. `SchemaBuilder.log()`
 * reports exactly the DDL TypeORM would need to reconcile the two: an empty
 * report is proof that the migrated schema is the schema the entities describe.
 *
 * The PostgreSQL half only runs when `CR_TEST_POSTGRES_URL` points at a live
 * database — CI's service container sets it; a laptop usually does not.
 */

const POSTGRES_URL = process.env.CR_TEST_POSTGRES_URL;

/**
 * The migrations that should run, derived from the registry rather than typed out.
 *
 * Both dialect blocks used to carry the same hand-written list and a hand-written
 * revert count beside it, and the PostgreSQL half has now been left behind by a
 * new migration twice — a failure that only ever shows up in CI, because the
 * PostgreSQL block is skipped on a laptop. Deriving them removes the half of the
 * assertion that was only ever a transcription exercise, and keeps the half that
 * is a real property: every registered migration applies, exactly once, in the
 * order the registry lists them — and `SchemaBuilder.log()` below is what proves
 * the result matches the entities, which is the check a stale list could never
 * have made anyway.
 */
const EXPECTED_MIGRATIONS = MIGRATIONS.map((migration) => migration.name);

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cr-migrations-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Whether one named index exists, read back from the live schema.
 *
 * Through TypeORM's table introspection for the same reason {@link isNullable}
 * is: the migration is written against the dialect-neutral `Table` API, so the
 * assertion has to read the same on both dialects.
 */
async function hasIndex(queryRunner: QueryRunner, table: string, name: string): Promise<boolean> {
  const found = await queryRunner.getTable(table);
  if (!found) {
    throw new Error(`${table} does not exist, so nothing can be concluded about its indices.`);
  }
  return found.indices.some((index) => index.name === name);
}

/**
 * One column, read back from the live schema.
 *
 * Through TypeORM's own table introspection rather than `PRAGMA` or
 * `information_schema`, so the assertions below read the same on both dialects —
 * which is the point of writing the migration against the `Table` API in the
 * first place.
 */
async function column(queryRunner: QueryRunner, table: string, name: string): Promise<TableColumn> {
  const found = (await queryRunner.getTable(table))?.findColumnByName(name);
  if (!found) {
    throw new Error(`${table}.${name} does not exist, so nothing can be concluded about it.`);
  }
  return found;
}

/** Its declared type — `text` against `varchar`, which is what SUP-243 changed. */
async function columnType(queryRunner: QueryRunner, table: string, name: string): Promise<string> {
  return (await column(queryRunner, table, name)).type;
}

/** Whether it admits NULL. */
async function isNullable(queryRunner: QueryRunner, table: string, name: string): Promise<boolean> {
  return (await column(queryRunner, table, name)).isNullable;
}

/**
 * The denial SUP-243 is about, at its real length: the one an operator is most
 * likely to misread, because the clause that corrects the misreading is the one
 * `varchar(255)` cut off.
 */
const FULL_DENIAL =
  'policy: the built-in pin policy (gatekeeper.default) denied (measurement ' +
  '74c75a0ba5f36e55548a14aa0dae0d0c9de9cd6ad041a4f6c553c996e2c579a7 is not listed in ' +
  'attestedRoots.trustedMeasurements — the Super Protocol registry does sign it, but in this mode the list is ' +
  'the sole authority and a registry signature admits nothing on its own)';

/**
 * One endpoint row carrying a reason. Through the repository rather than raw SQL
 * so the statement is the dialect's own — the two drivers do not even share a
 * parameter placeholder.
 */
async function insertEndpoint(dataSource: DataSource, id: string, lastReason: string): Promise<void> {
  await dataSource.getRepository(ExternalEndpoint).insert({
    id,
    name: id,
    baseUrl: 'https://partner.example',
    hostname: 'partner.example',
    listenPort: 19_001,
    apiKeyCiphertext: 'sealed',
    apiKeyPrefix: 'sk-up',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    lastReason,
  });
}

async function reasonOf(dataSource: DataSource, id: string): Promise<string | null> {
  return (await dataSource.getRepository(ExternalEndpoint).findOneByOrFail({ id })).lastReason;
}

/** One timeline entry on that endpoint, carrying a reason only the wide column holds. */
async function insertEvent(dataSource: DataSource, endpointId: string, reason: string): Promise<void> {
  await dataSource.getRepository(ExternalEndpointEvent).insert({
    id: `evt-${endpointId}`,
    externalEndpointId: endpointId,
    at: new Date(0),
    kind: 'denied',
    stage: 'policy',
    reason,
    measurement: null,
    evidenceDigest: null,
  });
}

/**
 * SUP-243's widening keeps what the narrow column held, and its `down` fits a
 * full-length denial back into the narrow one.
 *
 * Its own case, on both dialects, because the two do nothing alike: PostgreSQL
 * runs `ALTER COLUMN … TYPE text`, while SQLite has no `ALTER COLUMN` at all and
 * TypeORM rebuilds the table around the new definition. A rebuild that copied no
 * rows would still leave a schema matching the entities, so the drift check is
 * blind to it. And `down` has to narrow a column that by then holds 332
 * characters, which is why it truncates before it alters — without that, undoing
 * this migration on a live database fails on the data it is about.
 */
async function widensWithoutLosingAReason(dataSource: DataSource): Promise<void> {
  await dataSource.runMigrations({ transaction: 'all' });
  // Back to `varchar(255)`, so the row below is written through the old column
  // and the widening is what has to carry it forward.
  await dataSource.undoLastMigration({ transaction: 'all' });
  const clipped = `${FULL_DENIAL.slice(0, 254)}…`;
  await insertEndpoint(dataSource, 'widened', clipped);

  await dataSource.runMigrations({ transaction: 'all' });
  expect(await reasonOf(dataSource, 'widened')).toBe(clipped);

  // And a reason only the wide column can hold narrows back to one the old
  // column accepts, rather than failing the revert: the row is a projection the
  // next check rewrites.
  await insertEndpoint(dataSource, 'full', FULL_DENIAL);
  await dataSource.undoLastMigration({ transaction: 'all' });
  expect(await reasonOf(dataSource, 'full')).toBe(FULL_DENIAL.slice(0, 255));
  expect(await reasonOf(dataSource, 'widened')).toBe(clipped);
}

/**
 * …and refuses when the *timeline* needs the wide column.
 *
 * The other half of the same `down`, and the opposite answer, because the two
 * columns are different kinds of record: `external_endpoint_events` is
 * append-only and nothing re-derives it, so truncating would destroy the second
 * half of precisely the denials SUP-243 exists to keep.
 */
async function refusesToNarrowTheTimeline(dataSource: DataSource): Promise<void> {
  await dataSource.runMigrations({ transaction: 'all' });
  await insertEndpoint(dataSource, 'historic', FULL_DENIAL);
  await insertEvent(dataSource, 'historic', FULL_DENIAL);

  await expect(dataSource.undoLastMigration({ transaction: 'all' })).rejects.toThrow(
    /1 timeline entr\(ies\) hold a longer verdict reason/,
  );
  // And it refused without taking the explanation with it.
  const [event] = await dataSource.getRepository(ExternalEndpointEvent).find();
  expect(event.reason).toBe(FULL_DENIAL);
}

async function sqliteDataSource(): Promise<DataSource> {
  const dataSource = new DataSource(
    buildDataSourceOptions({
      type: 'sqlite',
      file: join(dir, 'router.sqlite'),
      migrationsRun: false,
      logging: false,
    }),
  );
  await dataSource.initialize();
  return dataSource;
}

describe('SQLite', () => {
  it('applies every migration to an empty database', async () => {
    const dataSource = await sqliteDataSource();
    try {
      const applied = await dataSource.runMigrations();
      expect(applied.map((migration) => migration.name)).toEqual(EXPECTED_MIGRATIONS);
    } finally {
      await dataSource.destroy();
    }
  });

  it('leaves a schema that matches the entities exactly', async () => {
    const dataSource = await sqliteDataSource();
    try {
      await dataSource.runMigrations();
      const { upQueries } = await dataSource.driver.createSchemaBuilder().log();

      expect(upQueries.map((query) => query.query)).toEqual([]);
    } finally {
      await dataSource.destroy();
    }
  });

  it('is idempotent when run twice', async () => {
    const dataSource = await sqliteDataSource();
    try {
      await dataSource.runMigrations();
      expect(await dataSource.runMigrations()).toEqual([]);
    } finally {
      await dataSource.destroy();
    }
  });

  it('widens a reason without losing it, and narrows a full one back', async () => {
    const dataSource = await sqliteDataSource();
    try {
      await widensWithoutLosingAReason(dataSource);
    } finally {
      await dataSource.destroy();
    }
  });

  it('refuses to narrow a timeline that needs the wide column', async () => {
    const dataSource = await sqliteDataSource();
    try {
      await refusesToNarrowTheTimeline(dataSource);
    } finally {
      await dataSource.destroy();
    }
  });

  it('reverts cleanly, one migration at a time', async () => {
    const dataSource = await sqliteDataSource();
    try {
      await dataSource.runMigrations();
      const queryRunner = dataSource.createQueryRunner();

      // SUP-243 widened the two verdict-reason columns to `text`; the first undo
      // narrows both back and touches nothing else. First because this migration
      // is numbered last — it was renumbered past the five `main` took during
      // review, because a migration is appended, never inserted.
      expect(await columnType(queryRunner, 'external_endpoints', 'lastReason')).toBe('text');
      expect(await columnType(queryRunner, 'external_endpoint_events', 'reason')).toBe('text');
      await dataSource.undoLastMigration();
      expect(await columnType(queryRunner, 'external_endpoints', 'lastReason')).toBe('varchar');
      expect(await columnType(queryRunner, 'external_endpoint_events', 'reason')).toBe('varchar');
      // The one column the narrowing must not have taken with it: SQLite has no
      // `ALTER COLUMN`, so TypeORM rebuilds the table, and a rebuild that lost a
      // sibling column would look exactly like a clean revert from here.
      expect(await queryRunner.hasColumn('external_endpoints', 'lastStage')).toBe(true);
      expect(await queryRunner.hasColumn('external_endpoint_events', 'evidenceDigest')).toBe(true);

      // SUP-481's record of the exports this deployment has taken is one additive
      // table; the next undo drops only that.
      expect(await queryRunner.hasTable('data_imports')).toBe(true);
      await dataSource.undoLastMigration();
      expect(await queryRunner.hasTable('data_imports')).toBe(false);

      // SUP-298 adds one index and nothing else; the next undo drops it and
      // leaves the indices that were already on the table.
      expect(await hasIndex(queryRunner, 'evidence_snapshots', 'IDX_evidence_snapshots_endpointId_issuedAt')).toBe(
        true,
      );
      await dataSource.undoLastMigration();
      expect(await hasIndex(queryRunner, 'evidence_snapshots', 'IDX_evidence_snapshots_endpointId_issuedAt')).toBe(
        false,
      );
      expect(await hasIndex(queryRunner, 'evidence_snapshots', 'IDX_evidence_snapshots_endpointId')).toBe(true);
      expect(await hasIndex(queryRunner, 'evidence_snapshots', 'IDX_evidence_snapshots_identity')).toBe(true);

      // SUP-423's partial index over the pending generations is next; the undo
      // drops that one index and leaves the two the Logs and Activity queries
      // run on.
      expect(await hasIndex(queryRunner, 'generations', 'IDX_generations_pending')).toBe(true);
      await dataSource.undoLastMigration();
      expect(await hasIndex(queryRunner, 'generations', 'IDX_generations_pending')).toBe(false);
      expect(await hasIndex(queryRunner, 'generations', 'IDX_generations_workspaceId_createdAt')).toBe(true);

      // SUP-406's operator column is one additive column; the next undo drops
      // only that and leaves the ledger it hangs off.
      expect(await queryRunner.hasColumn('credit_transactions', 'grantedByUserId')).toBe(true);
      await dataSource.undoLastMigration();
      expect(await queryRunner.hasColumn('credit_transactions', 'grantedByUserId')).toBe(false);
      expect(await queryRunner.hasColumn('credit_transactions', 'idempotencyKey')).toBe(true);

      // SUP-498 makes the evidence retention window enforceable: the two
      // documents it governs come off NOT NULL, `payloadStrippedAt` records when
      // the sweep took them, and the holder lookup gets its two indexes on
      // `generations`. Sixth now that SUP-406's column, SUP-423's index,
      // SUP-298's index, SUP-481's table and SUP-243's two `text` columns are
      // appended after it. The undo can only restore the NOT NULLs on a database
      // the sweep has not run on yet, which is this one.
      expect(await queryRunner.hasColumn('evidence_snapshots', 'payloadStrippedAt')).toBe(true);
      expect(await isNullable(queryRunner, 'evidence_snapshots', 'jws')).toBe(true);
      expect(await isNullable(queryRunner, 'evidence_snapshots', 'bundle')).toBe(true);
      await dataSource.undoLastMigration();
      expect(await queryRunner.hasColumn('evidence_snapshots', 'payloadStrippedAt')).toBe(false);
      expect(await isNullable(queryRunner, 'evidence_snapshots', 'jws')).toBe(false);
      expect(await isNullable(queryRunner, 'evidence_snapshots', 'bundle')).toBe(false);
      // The identity indices survive the SQLite column rebuild, which is the
      // half of this migration that could have taken them with it.
      expect(await queryRunner.hasColumn('evidence_snapshots', 'evidenceDigest')).toBe(true);
      // And the holder indexes go with it, off a table the rebuild never touched.
      expect(await hasIndex(queryRunner, 'generations', 'IDX_generations_evidenceSnapshotId')).toBe(false);

      // SUP-517's failure-run columns are five additive columns on one table;
      // the next undo drops only those.
      expect(await queryRunner.hasColumn('external_endpoints', 'consecutiveFailures')).toBe(true);
      await dataSource.undoLastMigration();
      for (const column of [
        'lastSuccessAt',
        'lastFailureAt',
        'notServingSince',
        'consecutiveFailures',
        'upstreamUnreachable',
      ]) {
        expect(await queryRunner.hasColumn('external_endpoints', column)).toBe(false);
      }
      expect(await queryRunner.hasColumn('external_endpoints', 'lastCheckedAt')).toBe(true);

      // SUP-551's mail address states are one additive table; the next undo
      // drops only that and leaves the rest of the schema alone.
      expect(await queryRunner.hasTable('mail_address_states')).toBe(true);
      await dataSource.undoLastMigration();
      expect(await queryRunner.hasTable('mail_address_states')).toBe(false);

      // SUP-466's client dimension is one additive column; the next undo drops
      // only that and leaves the rest of the metering row alone.
      expect(await queryRunner.hasColumn('generations', 'client')).toBe(true);
      await dataSource.undoLastMigration();
      expect(await queryRunner.hasColumn('generations', 'client')).toBe(false);
      expect(await queryRunner.hasColumn('generations', 'clientIpHash')).toBe(true);

      // SUP-260 drops the operator-declared TEE label from both catalogue
      // tables; the next undo puts the two columns back and nothing else.
      expect(await queryRunner.hasColumn('endpoints', 'tee')).toBe(false);
      expect(await queryRunner.hasColumn('models', 'tee')).toBe(false);
      await dataSource.undoLastMigration();
      expect(await queryRunner.hasColumn('endpoints', 'tee')).toBe(true);
      expect(await queryRunner.hasColumn('models', 'tee')).toBe(true);
      expect(await queryRunner.hasTable('invite_carried_redemptions')).toBe(true);

      // SUP-272's carried redemptions are one additive table; the next undo drops
      // only that and leaves the codes it pointed at.
      await dataSource.undoLastMigration();
      expect(await queryRunner.hasTable('invite_carried_redemptions')).toBe(false);
      expect(await queryRunner.hasTable('invite_redemptions')).toBe(true);

      // SUP-268's issuer column is one additive column; the next undo drops only that.
      expect(await queryRunner.hasColumn('invite_codes', 'issuedByUserId')).toBe(true);
      await dataSource.undoLastMigration();
      expect(await queryRunner.hasColumn('invite_codes', 'issuedByUserId')).toBe(false);
      expect(await queryRunner.hasColumn('invite_codes', 'note')).toBe(true);

      // SUP-252's two-factor trust added the pinned digest and the observed leaf;
      // the next undo drops both and touches nothing else.
      expect(await queryRunner.hasColumn('external_endpoints', 'pinnedEvidenceDigest')).toBe(true);
      await dataSource.undoLastMigration();
      expect(await queryRunner.hasColumn('external_endpoints', 'pinnedEvidenceDigest')).toBe(false);
      expect(await queryRunner.hasColumn('external_endpoints', 'observedCertFingerprint')).toBe(false);
      expect(await queryRunner.hasColumn('external_endpoints', 'pinnedCertFingerprint')).toBe(true);

      // SUP-251's registry signal is one additive column; the next undo drops only that.
      expect(await queryRunner.hasColumn('external_endpoints', 'measurementInRegistry')).toBe(true);
      await dataSource.undoLastMigration();
      expect(await queryRunner.hasColumn('external_endpoints', 'measurementInRegistry')).toBe(false);
      expect(await queryRunner.hasColumn('external_endpoints', 'measurementSource')).toBe(true);

      // ADR-008 §6's evidence leg loosened `evidence_snapshots.endpointId`; the
      // next undo puts the NOT NULL back and drops the column it added.
      expect(await isNullable(queryRunner, 'evidence_snapshots', 'endpointId')).toBe(true);
      await dataSource.undoLastMigration();
      expect(await isNullable(queryRunner, 'evidence_snapshots', 'endpointId')).toBe(false);
      expect(await queryRunner.hasColumn('evidence_snapshots', 'workloads')).toBe(false);
      // The column the previous migration loosened is untouched.
      expect(await isNullable(queryRunner, 'generations', 'endpointId')).toBe(true);

      // ADR-008's egress leg loosened `generations.endpointId`; the next undo puts
      // the NOT NULL back and leaves the previous migration's tables alone.
      expect(await isNullable(queryRunner, 'generations', 'endpointId')).toBe(true);
      await dataSource.undoLastMigration();
      expect(await isNullable(queryRunner, 'generations', 'endpointId')).toBe(false);
      expect(await queryRunner.hasTable('external_endpoints')).toBe(true);

      await dataSource.undoLastMigration();
      expect(await queryRunner.hasTable('external_endpoints')).toBe(false);
      expect(await queryRunner.hasTable('trusted_measurements')).toBe(false);
      expect(await queryRunner.hasTable('external_endpoint_events')).toBe(false);
      expect(await queryRunner.hasColumn('models', 'origin')).toBe(false);
      expect(await queryRunner.hasColumn('models', 'externalEndpointId')).toBe(false);
      expect(await queryRunner.hasColumn('generations', 'externalEndpointId')).toBe(false);
      expect(await queryRunner.hasColumn('evidence_snapshots', 'externalEndpointId')).toBe(false);
      // The column the previous migration added is untouched.
      expect(await queryRunner.hasColumn('endpoints', 'declaredImages')).toBe(true);

      await dataSource.undoLastMigration();
      expect(await queryRunner.hasColumn('endpoints', 'declaredImages')).toBe(false);
      // The tables the previous migration added are untouched.
      expect(await queryRunner.hasTable('chat_messages')).toBe(true);

      await dataSource.undoLastMigration();
      expect(await queryRunner.hasTable('chat_messages')).toBe(false);
      expect(await queryRunner.hasTable('chat_threads')).toBe(false);
      // The column the previous migration added is untouched.
      expect(await queryRunner.hasColumn('api_keys', 'purpose')).toBe(true);

      await dataSource.undoLastMigration();
      expect(await queryRunner.hasColumn('api_keys', 'purpose')).toBe(false);
      // The column the previous migration added is untouched.
      expect(await queryRunner.hasColumn('workspaces', 'firstRequestAt')).toBe(true);

      await dataSource.undoLastMigration();
      expect(await queryRunner.hasColumn('workspaces', 'firstRequestAt')).toBe(false);
      expect(await queryRunner.hasTable('feedback_submissions')).toBe(true);

      await dataSource.undoLastMigration();
      expect(await queryRunner.hasTable('feedback_submissions')).toBe(false);
      // The invitation tables the later migration did not create are untouched.
      expect(await queryRunner.hasTable('invite_codes')).toBe(true);

      await dataSource.undoLastMigration();
      expect(await queryRunner.hasTable('invite_redemptions')).toBe(false);
      expect(await queryRunner.hasTable('invite_codes')).toBe(false);
      // The tables the reverted migration did not create are untouched.
      expect(await queryRunner.hasTable('workspaces')).toBe(true);

      await dataSource.undoLastMigration();
      expect(await queryRunner.hasTable('workspaces')).toBe(false);
      expect(await queryRunner.hasTable('generations')).toBe(false);
      await queryRunner.release();
    } finally {
      await dataSource.destroy();
    }
  });
});

describe.skipIf(!POSTGRES_URL)('PostgreSQL', () => {
  async function postgresDataSource(): Promise<DataSource> {
    const dataSource = new DataSource(
      buildDataSourceOptions({
        type: 'postgres',
        url: POSTGRES_URL as string,
        migrationsRun: false,
        logging: false,
      }),
    );
    await dataSource.initialize();
    return dataSource;
  }

  beforeEach(async () => {
    const dataSource = await postgresDataSource();
    try {
      // Each run starts from nothing: the container is shared across test files.
      await dataSource.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    } finally {
      await dataSource.destroy();
    }
  });

  it('applies every migration and leaves a schema matching the entities', async () => {
    const dataSource = await postgresDataSource();
    try {
      const applied = await dataSource.runMigrations({ transaction: 'all' });
      expect(applied.map((migration) => migration.name)).toEqual(EXPECTED_MIGRATIONS);

      const { upQueries } = await dataSource.driver.createSchemaBuilder().log();
      expect(upQueries.map((query) => query.query)).toEqual([]);
    } finally {
      await dataSource.destroy();
    }
  });

  it('widens a reason without losing it, and narrows a full one back', async () => {
    const dataSource = await postgresDataSource();
    try {
      await widensWithoutLosingAReason(dataSource);
    } finally {
      await dataSource.destroy();
    }
  });

  it('refuses to narrow a timeline that needs the wide column', async () => {
    const dataSource = await postgresDataSource();
    try {
      await refusesToNarrowTheTimeline(dataSource);
    } finally {
      await dataSource.destroy();
    }
  });

  it('reverts cleanly', async () => {
    const dataSource = await postgresDataSource();
    try {
      await dataSource.runMigrations({ transaction: 'all' });
      // One undo per registered migration, so the database ends where it started
      // whatever the registry grows to. The count was hard-wired at 6 and silently
      // stopped covering `InitialSchema` the moment a seventh landed.
      for (let index = 0; index < EXPECTED_MIGRATIONS.length; index += 1) {
        await dataSource.undoLastMigration({ transaction: 'all' });
      }

      const queryRunner = dataSource.createQueryRunner();
      expect(await queryRunner.hasTable('external_endpoints')).toBe(false);
      expect(await queryRunner.hasColumn('endpoints', 'declaredImages')).toBe(false);
      expect(await queryRunner.hasTable('chat_threads')).toBe(false);
      expect(await queryRunner.hasTable('feedback_submissions')).toBe(false);
      expect(await queryRunner.hasTable('invite_codes')).toBe(false);
      // `InitialSchema` is the last one undone, so an off-by-one in the loop above
      // shows up here rather than as a clean-looking pass.
      expect(await queryRunner.hasTable('workspaces')).toBe(false);
      expect(await queryRunner.hasTable('generations')).toBe(false);
      await queryRunner.release();
    } finally {
      await dataSource.destroy();
    }
  });
});
