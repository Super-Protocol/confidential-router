import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
      expect(applied.map((migration) => migration.name)).toEqual([
        'InitialSchema1756600000000',
        'InviteCodes1758800000000',
        'FeedbackGrants1758900000000',
        'WorkspaceFirstRequest1759000000000',
        'ModelRequests1759100000000',
      ]);
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
      expect(await queryRunner.hasTable('model_requests')).toBe(false);
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
      expect(applied.map((migration) => migration.name)).toEqual([
        'InitialSchema1756600000000',
        'InviteCodes1758800000000',
        'FeedbackGrants1758900000000',
        'WorkspaceFirstRequest1759000000000',
        'ModelRequests1759100000000',
      ]);

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
      for (let index = 0; index < 5; index += 1) {
        await dataSource.undoLastMigration({ transaction: 'all' });
      }

      const queryRunner = dataSource.createQueryRunner();
      expect(await queryRunner.hasTable('feedback_submissions')).toBe(false);
      expect(await queryRunner.hasTable('invite_codes')).toBe(false);
      expect(await queryRunner.hasTable('workspaces')).toBe(false);
      await queryRunner.release();
    } finally {
      await dataSource.destroy();
    }
  });
});
