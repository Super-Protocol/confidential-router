import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../../migrations/index.js';
import { buildDataSourceOptions } from './data-source.js';

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

  it('reverts cleanly, one migration at a time', async () => {
    const dataSource = await sqliteDataSource();
    try {
      await dataSource.runMigrations();
      const queryRunner = dataSource.createQueryRunner();

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
