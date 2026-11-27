import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildDataSourceOptions } from '../db/data-source.js';
import { ApiKey } from '../db/entities/api-key.entity.js';
import { User } from '../db/entities/user.entity.js';
import { Workspace } from '../db/entities/workspace.entity.js';
import { WorkspaceMember } from '../db/entities/workspace-member.entity.js';
import { ApiKeyCensusService, whereHoldsLiveApiKey } from './api-key-census.service.js';

/**
 * The census on PostgreSQL — the database production uses (SUP-454).
 *
 * The rest of the suite runs on SQLite, and for most of this codebase that is
 * enough: the queries go through the repository API and TypeORM emits whatever
 * each driver wants. The census does not. It is the one place with hand-written
 * SQL — `CASE WHEN`, `COUNT(DISTINCT)`, `MAX` over a nullable bigint, an `IN`
 * over a subquery and a `NOT EXISTS` — and the shapes that differ between the two
 * drivers are exactly those. `api-key-census.service.spec.ts` proves the
 * behaviour; this proves the SQL runs where it has to.
 *
 * Opt-in, the same way `migrations.spec.ts` is: it runs only when
 * `CR_TEST_POSTGRES_URL` points at a live database, which CI's service container
 * sets and a laptop usually does not.
 */

const POSTGRES_URL = process.env.CR_TEST_POSTGRES_URL;

const NOW = new Date('2026-10-20T12:00:00Z');
const PAST = new Date('2026-10-01T00:00:00Z');

describe.skipIf(!POSTGRES_URL)('the API-key census, on PostgreSQL', () => {
  let dataSource: DataSource;
  let census: ApiKeyCensusService;
  let live: string;
  let revoked: string;
  let keyless: string;

  beforeAll(async () => {
    dataSource = new DataSource(
      buildDataSourceOptions({ type: 'postgres', url: POSTGRES_URL as string, migrationsRun: false, logging: false }),
    );
    await dataSource.initialize();
    await dataSource.runMigrations();
    // Better Auth owns `user` and creates it with its own migration, which this
    // suite does not run. Only the columns `User` maps are read here.
    await dataSource.query(
      'CREATE TABLE IF NOT EXISTS "user" ("id" varchar PRIMARY KEY, "email" varchar NOT NULL, ' +
        '"name" varchar NOT NULL, "image" varchar, "createdAt" timestamptz NOT NULL)',
    );

    // `totals` is deployment-wide, so every assertion below is a statement about
    // the whole database. Clearing first makes this spec independent of whatever
    // ran before it in the job rather than of the order the steps happen to be in.
    await clear();

    live = await seed('live@example.test', { keys: [{}] });
    revoked = await seed('revoked@example.test', { keys: [{ revokedAt: PAST }] });
    keyless = await seed('keyless@example.test', { keys: [] });
    await seed('chat@example.test', { keys: [{ purpose: 'console_chat' }] });
    // A membership whose account is gone — the shape `liveKeysWithoutAccount`
    // exists for, and the one `adminSignUps` can never list.
    const departed = await seed('gone@example.test', { keys: [{}] });
    await dataSource.query('DELETE FROM "user" WHERE "id" = $1', [departed]);

    census = new ApiKeyCensusService(dataSource);
  }, 60_000);

  afterAll(async () => {
    if (!dataSource?.isInitialized) {
      return;
    }
    // Shared with every other PostgreSQL test in the job, so this cleans up after
    // itself rather than dropping the schema out from under them.
    await clear();
    await dataSource.destroy();
  });

  /** Child tables first; `workspaces` has the only foreign keys that matter here. */
  async function clear(): Promise<void> {
    for (const table of ['api_keys', 'workspace_members', 'workspaces', 'user']) {
      await dataSource.query(`DELETE FROM "${table}"`);
    }
  }

  /** One account, its own workspace, and a key per entry. */
  async function seed(
    email: string,
    plan: { keys: { revokedAt?: Date; expiresAt?: Date; purpose?: 'console_chat' }[] },
  ): Promise<string> {
    const userId = randomUUID();
    await dataSource.query('INSERT INTO "user" ("id", "email", "name", "createdAt") VALUES ($1, $2, $3, $4)', [
      userId,
      email,
      '',
      PAST,
    ]);
    const workspaceId = randomUUID();
    await dataSource.getRepository(Workspace).insert({
      id: workspaceId,
      name: 'Workspace',
      slug: `ws-${workspaceId.slice(0, 8)}`,
      balanceMicros: 0,
      autoTopUpEnabled: false,
      createdAt: PAST,
    });
    await dataSource.getRepository(WorkspaceMember).insert({ workspaceId, userId, role: 'owner', createdAt: PAST });
    for (const key of plan.keys) {
      await dataSource.getRepository(ApiKey).insert({
        id: randomUUID(),
        workspaceId,
        name: 'Production',
        keyHash: randomUUID().replaceAll('-', ''),
        prefix: 'sk-tee-v1-4f',
        modelScope: null,
        spentTotalMicros: 0,
        lastUsedAt: new Date('2026-10-18T00:00:00Z'),
        expiresAt: key.expiresAt ?? null,
        revokedAt: key.revokedAt ?? null,
        purpose: key.purpose ?? null,
        createdAt: PAST,
      });
    }
    return userId;
  }

  it('groups and counts per account — `CASE WHEN`, `MAX` over a bigint, and the chat exclusion', async () => {
    const map = await census.forUsers([live, revoked, keyless], NOW);

    expect(map.get(live)).toEqual({ total: 1, live: 1, lastUsedAt: new Date('2026-10-18T00:00:00Z') });
    expect(map.get(revoked)).toMatchObject({ total: 1, live: 0 });
    expect(map.has(keyless)).toBe(false);
  });

  it('totals the deployment — `COUNT(DISTINCT)` and the `NOT EXISTS` over the orphaned membership', async () => {
    expect(await census.totals(NOW)).toEqual({
      keys: 3,
      liveKeys: 2,
      // The departed holder's key is live and counted, but its holder is not an
      // account, so it lands in the remainder rather than in the announce list.
      accountsHoldingLiveKey: 1,
      liveKeysWithoutAccount: 1,
    });
  });

  it('filters accounts — the `IN` / `NOT IN` over the holders subquery', async () => {
    const emails = async (holds: boolean) => {
      const query = dataSource.getRepository(User).createQueryBuilder('account');
      whereHoldsLiveApiKey(query, { accountAlias: 'account', holds, now: NOW });
      return (await query.orderBy('account.email', 'ASC').getMany()).map((row) => row.email);
    };

    expect(await emails(true)).toEqual(['live@example.test']);
    expect(await emails(false)).toEqual(['chat@example.test', 'keyless@example.test', 'revoked@example.test']);
    // The number above the table and the table itself, on PostgreSQL too.
    expect((await census.totals(NOW)).accountsHoldingLiveKey).toBe((await emails(true)).length);
  });
});
