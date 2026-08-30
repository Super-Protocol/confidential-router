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
