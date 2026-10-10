import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { dropStoredCredentials } from './auth-schema.js';

/** Better Auth's `account` table, the three columns that matter here. */
function accounts() {
  const database = new Database(':memory:');
  database.exec('CREATE TABLE "account" ("id" TEXT PRIMARY KEY, "userId" TEXT, "providerId" TEXT, "password" TEXT)');
  const insert = database.prepare('INSERT INTO "account" VALUES (?, ?, ?, ?)');
  insert.run('a1', 'u1', 'credential', 'salt:hash-of-a-password');
  insert.run('a2', 'u2', 'credential', 'salt:another-hash');
  insert.run('a3', 'u2', 'github', null);
  return database;
}

describe('dropStoredCredentials', () => {
  it('deletes every password hash and leaves OAuth accounts alone (SUP-269)', async () => {
    const database = accounts();

    await expect(dropStoredCredentials(database)).resolves.toBe(2);

    expect(database.prepare('SELECT "id", "providerId", "password" FROM "account"').all()).toEqual([
      { id: 'a3', providerId: 'github', password: null },
    ]);
  });

  it('is safe to run on every boot: the second run finds nothing', async () => {
    const database = accounts();
    await dropStoredCredentials(database);

    await expect(dropStoredCredentials(database)).resolves.toBe(0);
  });

  it('issues the same statement through a PostgreSQL pool', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 5 });

    await expect(dropStoredCredentials({ query } as never)).resolves.toBe(5);
    expect(query).toHaveBeenCalledWith(`DELETE FROM "account" WHERE "providerId" = 'credential'`);
  });
});
