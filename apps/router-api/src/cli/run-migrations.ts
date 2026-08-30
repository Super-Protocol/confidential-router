#!/usr/bin/env node
/**
 * Applies every pending schema change, then exits.
 *
 * Two owners, one command (ADR-004 §3): Better Auth migrates its four tables,
 * TypeORM migrates the ten this service owns. Deployments run this once — from a
 * job, not from every replica — which is why `database.migrationsRun` defaults
 * to off on PostgreSQL.
 *
 *   CR_API_DATABASE__TYPE=postgres CR_API_DATABASE__URL=postgres://… \
 *     node dist/cli/run-migrations.js
 */
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { buildAuthOptions, createAuthDatabase } from '../app/auth/auth.options.js';
import { runAuthMigrations } from '../app/auth/auth-schema.js';
import { loadRouterConfig } from '../app/config.js';
import { buildDataSourceOptions, ensureSqliteDirectory } from '../app/db/data-source.js';

async function main(): Promise<void> {
  const config = loadRouterConfig({ onWarning: (message) => console.warn(`[migrate] ${message}`) });

  if (config.database.type === 'sqlite') {
    ensureSqliteDirectory(config.database.file);
    console.log(`[migrate] SQLite: ${config.database.file}`);
  } else {
    console.log('[migrate] PostgreSQL');
  }

  const authDatabase = createAuthDatabase(config);
  try {
    await runAuthMigrations(
      buildAuthOptions({
        config,
        // Migrations never send anything; a mailer that refuses to be used makes
        // that explicit instead of quietly instantiating a real one.
        mailer: {
          send: async () => {
            throw new Error('The migration runner must not send email.');
          },
        },
        database: authDatabase,
      }),
    );
    console.log('[migrate] Better Auth schema is up to date.');
  } finally {
    await closeAuthDatabase(authDatabase);
  }

  const dataSource = new DataSource(buildDataSourceOptions(config.database));
  await dataSource.initialize();
  try {
    const applied = await dataSource.runMigrations({ transaction: 'all' });
    console.log(
      applied.length === 0
        ? '[migrate] No pending migrations.'
        : `[migrate] Applied: ${applied.map((migration) => migration.name).join(', ')}`,
    );
  } finally {
    await dataSource.destroy();
  }
}

async function closeAuthDatabase(handle: unknown): Promise<void> {
  const closable = handle as { end?: () => Promise<void>; close?: () => void };
  if (typeof closable?.end === 'function') {
    await closable.end();
  } else if (typeof closable?.close === 'function') {
    closable.close();
  }
}

main().catch((error: unknown) => {
  console.error('[migrate] Failed:', error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
