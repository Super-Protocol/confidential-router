import type { BetterAuthOptions } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';

/**
 * Creates and evolves the four tables Better Auth owns (`user`, `session`,
 * `account`, `verification`).
 *
 * ADR-004 §3 leaves that schema to the library rather than transcribing it into
 * a TypeORM migration: the shape is the library's to change, and a copy would
 * silently rot the first time it did. `router-api-migrate` calls this and then
 * `dataSource.runMigrations()`, so a deployment still has one command to run.
 */
export async function runAuthMigrations(options: BetterAuthOptions): Promise<void> {
  const { runMigrations } = await getMigrations(options);
  await runMigrations();
}

/**
 * Deletes every password hash earlier versions stored (SUP-269).
 *
 * Password sign-in is gone, so a `credential` row in Better Auth's `account`
 * table is a hash that nothing reads and that a database leak would still
 * expose to offline guessing. The row is the whole of a password account's
 * credential — its `user` row, workspace and balance are untouched, and the
 * same address signs in afterwards with a mailed code.
 *
 * Run right after the library's own migrations, by the same two callers, and
 * safe to run every time: once the rows are gone it deletes nothing. It is here
 * and not a TypeORM migration for the reason `runAuthMigrations` is: the table
 * is Better Auth's (ADR-004 §2), reached through Better Auth's own connection.
 *
 * @returns how many credentials were removed, for the caller's log line.
 */
export async function dropStoredCredentials(database: BetterAuthOptions['database']): Promise<number> {
  const handle = database as {
    prepare?: (sql: string) => { run: () => { changes: number } };
    query?: (sql: string) => Promise<{ rowCount: number | null }>;
  };
  if (typeof handle.prepare === 'function') {
    return handle.prepare(`DELETE FROM "account" WHERE "providerId" = 'credential'`).run().changes;
  }
  if (typeof handle.query === 'function') {
    return (await handle.query(`DELETE FROM "account" WHERE "providerId" = 'credential'`)).rowCount ?? 0;
  }
  throw new Error('dropStoredCredentials: unsupported auth database handle.');
}
