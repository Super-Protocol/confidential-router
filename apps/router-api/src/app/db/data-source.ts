import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DataSourceOptions } from 'typeorm';
import { MIGRATIONS } from '../../migrations/index.js';
import type { DatabaseConfig } from '../config.schema.js';
import { ENTITIES } from './entities/index.js';

/**
 * `better-sqlite3` will not create the directory holding the database file, and
 * the zero-config default lives under `data/`. Creating it here keeps the first
 * `nx serve` on a fresh clone from failing on a missing directory.
 */
export function ensureSqliteDirectory(file: string): void {
  if (file !== ':memory:') {
    mkdirSync(dirname(file), { recursive: true });
  }
}

/**
 * The single place that turns `database` config into TypeORM options.
 *
 * `synchronize` is hard-coded to `false` for both drivers. Migrations own the
 * schema everywhere — including SQLite, so that what a developer runs against is
 * the schema CI and production get, not TypeORM's best guess at it.
 */
export function buildDataSourceOptions(config: DatabaseConfig): DataSourceOptions {
  const base = {
    entities: ENTITIES,
    migrations: MIGRATIONS,
    migrationsTableName: 'router_api_migrations',
    synchronize: false,
    logging: config.logging,
  } as const;

  if (config.type === 'sqlite') {
    return { ...base, type: 'better-sqlite3', database: config.file };
  }
  return { ...base, type: 'postgres', url: config.url };
}
