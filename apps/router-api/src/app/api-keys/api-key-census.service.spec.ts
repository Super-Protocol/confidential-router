import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDataSource } from '../../../test/seed.js';
import { ApiKey, type ApiKeyPurpose } from '../db/entities/api-key.entity.js';
import { User } from '../db/entities/user.entity.js';
import { Workspace } from '../db/entities/workspace.entity.js';
import { WorkspaceMember } from '../db/entities/workspace-member.entity.js';
import { ApiKeyCensusService, NO_API_KEYS, whereHoldsLiveApiKey } from './api-key-census.service.js';

/**
 * The operator-side credential census (SUP-454): how many keys an account holds,
 * how many still work, and the deployment-wide totals that size a key-affecting
 * change. No test here asserts a key, a hash or a prefix, because the surface
 * answers none.
 */

const NOW = new Date('2026-10-20T12:00:00Z');
const PAST = new Date('2026-10-01T00:00:00Z');
const FUTURE = new Date('2026-12-01T00:00:00Z');

let dataSource: DataSource;
let census: ApiKeyCensusService;

beforeEach(async () => {
  dataSource = await createTestDataSource();
  census = new ApiKeyCensusService(dataSource);
  // Better Auth owns `user` and creates it with its own migration, which a unit
  // test does not run. Only the columns `User` maps are read here.
  await dataSource.query(
    'CREATE TABLE "user" ("id" varchar PRIMARY KEY, "email" varchar NOT NULL, "name" varchar NOT NULL, "image" varchar, "createdAt" date NOT NULL)',
  );
});

afterEach(async () => {
  await dataSource.destroy();
});

async function account(email: string): Promise<string> {
  const id = randomUUID();
  await dataSource.query('INSERT INTO "user" ("id", "email", "name", "createdAt") VALUES (?, ?, ?, ?)', [
    id,
    email,
    '',
    PAST.toISOString(),
  ]);
  return id;
}

async function workspace(members: readonly string[]): Promise<string> {
  const id = randomUUID();
  await dataSource.getRepository(Workspace).insert({
    id,
    name: 'Workspace',
    slug: `ws-${id.slice(0, 8)}`,
    balanceMicros: 0,
    autoTopUpEnabled: false,
    createdAt: PAST,
  });
  for (const userId of members) {
    await dataSource.getRepository(WorkspaceMember).insert({ workspaceId: id, userId, role: 'owner', createdAt: PAST });
  }
  return id;
}

async function key(
  workspaceId: string,
  state: { revokedAt?: Date; expiresAt?: Date; lastUsedAt?: Date; purpose?: ApiKeyPurpose } = {},
): Promise<string> {
  const id = randomUUID();
  await dataSource.getRepository(ApiKey).insert({
    id,
    workspaceId,
    name: 'Production',
    keyHash: randomUUID().replaceAll('-', ''),
    prefix: 'sk-tee-v1-4f',
    modelScope: null,
    spentTotalMicros: 0,
    expiresAt: state.expiresAt ?? null,
    lastUsedAt: state.lastUsedAt ?? null,
    revokedAt: state.revokedAt ?? null,
    purpose: state.purpose ?? null,
    createdAt: PAST,
  });
  return id;
}

describe("an account's census", () => {
  it('counts the keys of every workspace the account belongs to', async () => {
    const holder = await account('dev@example.com');
    await key(await workspace([holder]), { lastUsedAt: new Date('2026-10-18T00:00:00Z') });
    await key(await workspace([holder]), { lastUsedAt: new Date('2026-10-19T00:00:00Z') });

    expect((await census.forUsers([holder], NOW)).get(holder)).toEqual({
      total: 2,
      live: 2,
      lastUsedAt: new Date('2026-10-19T00:00:00Z'),
    });
  });

  it('counts a revoked or expired key in the total but not as live', async () => {
    const holder = await account('dev@example.com');
    const shared = await workspace([holder]);
    await key(shared);
    await key(shared, { revokedAt: PAST });
    await key(shared, { expiresAt: PAST });
    await key(shared, { expiresAt: FUTURE });

    expect((await census.forUsers([holder], NOW)).get(holder)).toMatchObject({ total: 4, live: 2 });
  });

  it('leaves an account with no key out of the map, for the caller to read as none', async () => {
    const quiet = await account('quiet@example.com');
    await workspace([quiet]);

    const map = await census.forUsers([quiet], NOW);

    expect(map.has(quiet)).toBe(false);
    expect(map.get(quiet) ?? NO_API_KEYS).toEqual({ total: 0, live: 0, lastUsedAt: null });
  });

  it('answers null for last used when no key of the account was ever used', async () => {
    const holder = await account('dev@example.com');
    await key(await workspace([holder]));

    expect((await census.forUsers([holder], NOW)).get(holder)?.lastUsedAt).toBeNull();
  });

  it('credits a shared workspace’s key to every member, so neither is missed on a re-issue', async () => {
    const one = await account('one@example.com');
    const two = await account('two@example.com');
    await key(await workspace([one, two]));

    const map = await census.forUsers([one, two], NOW);

    expect(map.get(one)).toMatchObject({ total: 1, live: 1 });
    expect(map.get(two)).toMatchObject({ total: 1, live: 1 });
  });

  it('asks nothing of the database for an empty account list', async () => {
    expect(await census.forUsers([], NOW)).toEqual(new Map());
  });

  /**
   * The console's chat key is not a credential anyone re-issues — the Chat screen
   * mints and rotates its own. Leaving it in would put a member who once opened
   * Chat on the announce list, and, because revocation is a timestamp and not a
   * delete, would leave every chat session the deployment ever served in `total`.
   */
  it('leaves the console’s own chat credential out, live or long revoked', async () => {
    const holder = await account('dev@example.com');
    const shared = await workspace([holder]);
    await key(shared, { lastUsedAt: new Date('2026-10-10T00:00:00Z') });
    await key(shared, { purpose: 'console_chat', lastUsedAt: new Date('2026-10-19T00:00:00Z') });
    await key(shared, { purpose: 'console_chat', revokedAt: PAST });

    expect((await census.forUsers([holder], NOW)).get(holder)).toEqual({
      total: 1,
      live: 1,
      lastUsedAt: new Date('2026-10-10T00:00:00Z'),
    });
  });

  it('reads an account whose only key is the chat one as holding none', async () => {
    const chatter = await account('chat@example.com');
    await key(await workspace([chatter]), { purpose: 'console_chat' });

    expect((await census.forUsers([chatter], NOW)).has(chatter)).toBe(false);
  });
});

describe('the deployment-wide population', () => {
  it('separates live keys from every key, and counts the accounts holding one', async () => {
    const one = await account('one@example.com');
    const two = await account('two@example.com');
    const none = await account('none@example.com');
    await key(await workspace([one]));
    const shared = await workspace([one, two]);
    await key(shared);
    await key(shared, { revokedAt: PAST });
    await workspace([none]);

    expect(await census.totals(NOW)).toEqual({
      keys: 3,
      liveKeys: 2,
      accountsHoldingLiveKey: 2,
      liveKeysWithoutAccount: 0,
    });
  });

  /**
   * No code path produces this orphan today — account deletion is not wired, and
   * the import refuses a bundle whose memberships name accounts it does not
   * carry. The schema is what allows it: `workspace_members` has no foreign key
   * to Better Auth's `user`, so nothing stops a membership outliving the account
   * it names. `adminSignUps` selects from `user`, so such a holder could never
   * appear on the list; its keys have to be counted where the operator will see
   * them, or the two numbers stop reconciling the first time one appears.
   */
  it('counts a live key held only through a membership whose account is gone', async () => {
    const holder = await account('one@example.com');
    const departed = await account('gone@example.com');
    await key(await workspace([holder]));
    await key(await workspace([departed]));
    await dataSource.query('DELETE FROM "user" WHERE "id" = ?', [departed]);

    expect(await census.totals(NOW)).toMatchObject({
      keys: 2,
      liveKeys: 2,
      // Not 2: the operator will page `adminSignUps`, which cannot return the
      // departed holder, so promising two accounts here would be a number they
      // could never reconcile.
      accountsHoldingLiveKey: 1,
      liveKeysWithoutAccount: 1,
    });
  });

  it('counts a live key in a workspace with no membership at all, unreachable as that is', async () => {
    const holder = await account('one@example.com');
    await key(await workspace([holder]));
    await key(await workspace([]));

    expect(await census.totals(NOW)).toMatchObject({
      keys: 2,
      liveKeys: 2,
      accountsHoldingLiveKey: 1,
      liveKeysWithoutAccount: 1,
    });
  });

  it('is all zeros on a deployment with no keys', async () => {
    await workspace([await account('one@example.com')]);

    expect(await census.totals(NOW)).toEqual({
      keys: 0,
      liveKeys: 0,
      accountsHoldingLiveKey: 0,
      liveKeysWithoutAccount: 0,
    });
  });

  it('counts no chat credential — not in the total, not as live, not as an account', async () => {
    const chatter = await account('chat@example.com');
    await key(await workspace([chatter]), { purpose: 'console_chat' });
    await key(await workspace([]), { purpose: 'console_chat' });

    expect(await census.totals(NOW)).toEqual({
      keys: 0,
      liveKeys: 0,
      accountsHoldingLiveKey: 0,
      liveKeysWithoutAccount: 0,
    });
  });

  it('counts the key once however many members its workspace has', async () => {
    const one = await account('one@example.com');
    const two = await account('two@example.com');
    await key(await workspace([one, two]));

    expect(await census.totals(NOW)).toMatchObject({ keys: 1, liveKeys: 1, accountsHoldingLiveKey: 2 });
  });
});

/**
 * The one property that makes the two surfaces usable together: an operator reads
 * "N accounts hold a live key", pages `adminSignUps(holdsLiveApiKey: true)`, and
 * has to get N rows. A membership whose account is gone used to break this —
 * counted in the total, unlistable on the page — which is the blind spot SUP-454
 * exists to close, so it is asserted rather than left to the two call sites.
 */
describe('the total and the list', () => {
  it('agree on how many accounts hold a live key, orphaned memberships and all', async () => {
    const holder = await account('one@example.com');
    const departed = await account('gone@example.com');
    const shared = await workspace([holder, await account('two@example.com')]);
    await key(shared);
    await key(await workspace([departed]));
    await dataSource.query('DELETE FROM "user" WHERE "id" = ?', [departed]);

    const totals = await census.totals(NOW);
    const query = dataSource.getRepository(User).createQueryBuilder('account');
    whereHoldsLiveApiKey(query, { accountAlias: 'account', holds: true, now: NOW });

    expect(totals.accountsHoldingLiveKey).toBe(await query.getCount());
    // And the key the list cannot speak for is named rather than silently missing.
    expect(totals.liveKeysWithoutAccount).toBe(1);
  });
});

describe('the holds-a-live-key filter', () => {
  async function accounts(holds: boolean): Promise<string[]> {
    const query = dataSource.getRepository(User).createQueryBuilder('account');
    whereHoldsLiveApiKey(query, { accountAlias: 'account', holds, now: NOW });
    return (await query.orderBy('account.email', 'ASC').getMany()).map((row) => row.email);
  }

  beforeEach(async () => {
    const live = await account('live@example.com');
    const revoked = await account('revoked@example.com');
    const expired = await account('expired@example.com');
    const keyless = await account('keyless@example.com');
    const chatter = await account('chat@example.com');
    await key(await workspace([live]));
    await key(await workspace([revoked]), { revokedAt: PAST });
    await key(await workspace([expired]), { expiresAt: PAST });
    await workspace([keyless]);
    await key(await workspace([chatter]), { purpose: 'console_chat' });
  });

  it('does not put an open Chat tab on the re-issue list', async () => {
    expect(await accounts(true)).not.toContain('chat@example.com');
    expect(await accounts(false)).toContain('chat@example.com');
  });

  it('keeps only the accounts a rebuild would cut off', async () => {
    expect(await accounts(true)).toEqual(['live@example.com']);
  });

  it('keeps only the accounts with nothing left to void, revoked and expired included', async () => {
    expect(await accounts(false)).toEqual([
      'chat@example.com',
      'expired@example.com',
      'keyless@example.com',
      'revoked@example.com',
    ]);
  });

  it('partitions the accounts, so the two answers add up to all of them', async () => {
    const [holding, not] = [await accounts(true), await accounts(false)];

    expect([...holding, ...not].sort()).toEqual(
      (await dataSource.getRepository(User).find()).map((row) => row.email).sort(),
    );
  });
});
