import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../src/app/db/data-source.js';

export interface SqliteFixture {
  dataSource: DataSource;
  close(): Promise<void>;
}

/**
 * A migrated, throwaway SQLite database for the service tests.
 *
 * Migrated rather than synchronised: `migrations.spec.ts` proves the migration
 * and the entities agree, so a test that runs against the migrated schema is
 * running against the schema production gets.
 */
export async function createSqliteFixture(prefix = 'cr-db-'): Promise<SqliteFixture> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const dataSource = new DataSource(
    buildDataSourceOptions({ type: 'sqlite', file: join(dir, 'router.sqlite'), migrationsRun: false, logging: false }),
  );
  await dataSource.initialize();
  await dataSource.runMigrations();
  return {
    dataSource,
    close: async () => {
      await dataSource.destroy();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
