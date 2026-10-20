import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiKey } from '../src/app/db/entities/api-key.entity.js';
import { createHarness, type Harness } from './app-harness.js';
import { anonymous, type ConsoleSession, dataSourceOf, expectData, graphql, signIn } from './console.js';

/**
 * SUP-454, end to end: an operator who is a member of no workspace but their own
 * can answer "which accounts here hold a live key", and can answer it without
 * being handed a credential.
 *
 * That was the gap the SUP-434 rebuild fell into. `apiKeys(workspaceId)` calls
 * `requireMembership`, so the only person who could have listed the eight
 * affected accounts was each of those accounts — the loss had to be inferred from
 * the credit ledger instead. The first test here is that 403, kept as a test
 * rather than a memory, because it is the reason the rest of this file exists.
 */

const OPERATOR = 'ops@confidential-router.local';

const CREATE = `mutation Create($input: CreateApiKeyInput!) {
  createApiKey(input: $input) { secret key { id } }
}`;

const REVOKE = 'mutation Revoke($id: ID!) { revokeApiKey(id: $id) { id revokedAt } }';

const CENSUS = `query Census($holdsLiveApiKey: Boolean) {
  adminSignUps(holdsLiveApiKey: $holdsLiveApiKey, offset: 0, limit: 50) {
    totalCount
    nodes { email apiKeys { total live lastUsedAt } }
  }
}`;

const POPULATION = `{
  adminApiKeyPopulation { keys liveKeys accountsHoldingLiveKey liveKeysWithoutAccount }
}`;

let harness: Harness;
let operator: ConsoleSession;
let holder: ConsoleSession;
let keyless: ConsoleSession;
let secret: string;
let keyId: string;

beforeAll(async () => {
  harness = await createHarness({ env: { CR_API_AUTH__ADMIN_EMAILS: OPERATOR } });
  operator = await signIn(harness, OPERATOR);
  holder = await signIn(harness, 'holder@example.test');
  keyless = await signIn(harness, 'keyless@example.test');

  const created = await expectData(holder, CREATE, { input: { workspaceId: holder.workspaceId, name: 'Production' } });
  secret = created.createApiKey.secret;
  keyId = created.createApiKey.key.id;
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

/** The GraphQL error code of the first error, as `formatConsoleError` emits it. */
function codeOf(body: { errors?: { extensions?: { code?: unknown } }[] }): unknown {
  return body.errors?.[0]?.extensions?.code;
}

async function census(holdsLiveApiKey: boolean | null = null) {
  return (await expectData(operator, CENSUS, { holdsLiveApiKey })).adminSignUps;
}

function rowOf(page: { nodes: { email: string }[] }, email: string) {
  const row = page.nodes.find((node) => node.email === email);
  expect(row, `${email} is missing from the account list`).toBeDefined();
  return row as { email: string; apiKeys: { total: number; live: number; lastUsedAt: string | null } };
}

describe('the gap this closes', () => {
  it('still refuses the operator the keys of a workspace they are not in', async () => {
    const body = await graphql(operator, 'query($id: ID!) { apiKeys(workspaceId: $id) { id } }', {
      id: holder.workspaceId,
    });

    // Unchanged on purpose: tenancy is not what SUP-454 relaxes. The census is a
    // separate, admin-guarded surface that answers counts instead.
    expect(codeOf(body)).toBe('FORBIDDEN');
  });
});

describe('the account list, for an operator', () => {
  it('says how many keys each account holds', async () => {
    const page = await census();

    expect(rowOf(page, 'holder@example.test').apiKeys).toMatchObject({ total: 1, live: 1, lastUsedAt: null });
    expect(rowOf(page, 'keyless@example.test').apiKeys).toMatchObject({ total: 0, live: 0, lastUsedAt: null });
    expect(rowOf(page, OPERATOR).apiKeys).toMatchObject({ total: 0, live: 0 });
  });

  it('answers who must re-issue, and sizes it with the same totalCount', async () => {
    const holding = await census(true);

    expect(holding.totalCount).toBe(1);
    expect(holding.nodes.map((node: { email: string }) => node.email)).toEqual(['holder@example.test']);
  });

  it('answers the complement too, so an announcement can skip the accounts with nothing to lose', async () => {
    const not = await census(false);

    expect(not.nodes.map((node: { email: string }) => node.email).sort()).toEqual(
      ['keyless@example.test', OPERATOR].sort(),
    );
  });

  it('discloses no key material anywhere in the answer', async () => {
    const answered = JSON.stringify(await census());

    expect(answered).not.toContain(secret);
    expect(answered).not.toContain(secret.slice(0, 12));
    expect(answered).not.toMatch(/sk-tee/);
  });
});

describe('the deployment-wide population', () => {
  it('counts the keys and the accounts holding one', async () => {
    expect((await expectData(operator, POPULATION)).adminApiKeyPopulation).toEqual({
      keys: 1,
      liveKeys: 1,
      accountsHoldingLiveKey: 1,
      liveKeysWithoutAccount: 0,
    });
  });

  it('is refused to a member and to a caller with no session', async () => {
    expect(codeOf(await graphql(keyless, POPULATION))).toBe('FORBIDDEN');
    expect(codeOf(await graphql(anonymous(harness), POPULATION))).toBe('UNAUTHENTICATED');
  });
});

/**
 * The Chat screen mints a `console_chat` key for itself and rotates its own. It
 * is inserted directly here rather than through `chatCredential`, which needs a
 * chat-capable catalogue this harness has no reason to serve — what is under test
 * is the census, not the minting.
 */
describe('the console’s own chat credential', () => {
  it('puts nobody on the re-issue list and nothing in the counts', async () => {
    await dataSourceOf(harness)
      .getRepository(ApiKey)
      .insert({
        id: randomUUID(),
        workspaceId: keyless.workspaceId,
        name: 'Console chat',
        keyHash: randomUUID().replaceAll('-', ''),
        prefix: 'sk-tee-v1-9a',
        purpose: 'console_chat',
        modelScope: null,
        spentTotalMicros: 0,
        createdAt: new Date(),
      });

    expect(rowOf(await census(), 'keyless@example.test').apiKeys).toMatchObject({ total: 0, live: 0 });
    expect((await census(true)).nodes.map((node: { email: string }) => node.email)).toEqual(['holder@example.test']);
    expect((await expectData(operator, POPULATION)).adminApiKeyPopulation).toMatchObject({ keys: 1, liveKeys: 1 });
  });
});

/**
 * A membership whose `userId` has no `user` row — forced here, because nothing in
 * the running system produces one: account deletion is not wired and the import
 * refuses a bundle that would write it. The shape is allowed by the schema alone,
 * since `workspace_members` has no foreign key to Better Auth's `user`.
 *
 * It is worth an e2e anyway. `adminSignUps` selects from `user`, so such a holder
 * could never be listed, and an unexplained gap between a number and the page it
 * promises is the blind spot SUP-454 exists to close.
 */
describe('a live key whose holder is no longer an account', () => {
  it('is counted as a remainder, not as someone the operator could tell', async () => {
    const departed = await signIn(harness, 'departed@example.test');
    const created = await expectData(departed, CREATE, {
      input: { workspaceId: departed.workspaceId, name: 'Left behind' },
    });
    // `?` and not `$1`: the harness runs on SQLite, as every e2e here does.
    await dataSourceOf(harness).query('DELETE FROM "user" WHERE "id" = ?', [
      (await expectData(departed, '{ me { id } }')).me.id,
    ]);

    const population = (await expectData(operator, POPULATION)).adminApiKeyPopulation;
    const holding = await census(true);

    expect(population.liveKeys).toBe(2);
    expect(population.liveKeysWithoutAccount).toBe(1);
    // The promise the banner makes: the number and the page agree, with the
    // unlistable holder accounted for separately rather than silently missing.
    expect(population.accountsHoldingLiveKey).toBe(holding.totalCount);
    expect(holding.nodes.map((node: { email: string }) => node.email)).toEqual(['holder@example.test']);

    // Leave the deployment as the later tests expect to find it.
    await dataSourceOf(harness).getRepository(ApiKey).delete({ id: created.createApiKey.key.id });
  });
});

describe('after the key is used and revoked', () => {
  it('reports the use, then stops counting the key as live while keeping it in the total', async () => {
    // `ApiKeyGuard` stamps `lastUsedAt` on every authenticated `/v1` call, so the
    // cheapest one is enough — no generation needed to make a key look used.
    await request(harness.app.getHttpServer()).get('/v1/models').set('Authorization', `Bearer ${secret}`).expect(200);

    const used = rowOf(await census(), 'holder@example.test');
    expect(used.apiKeys.lastUsedAt).not.toBeNull();

    await expectData(holder, REVOKE, { id: keyId });

    expect(rowOf(await census(), 'holder@example.test').apiKeys).toMatchObject({ total: 1, live: 0 });
    expect((await census(true)).totalCount).toBe(0);
    expect((await expectData(operator, POPULATION)).adminApiKeyPopulation).toMatchObject({
      keys: 1,
      liveKeys: 0,
      accountsHoldingLiveKey: 0,
    });
  });
});
