import { randomUUID } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LedgerService } from '../src/app/billing/index.js';
import {
  CARRIED_NON_CREDENTIAL_PATHS,
  CREDENTIAL_KEY_PATTERN,
  credentialShapedKeys,
  DATA_EXPORT_CONTENT_TYPE,
  decodeBundle,
  type ExportBundle,
  type ImportReport,
} from '../src/app/data-migration/index.js';
import { ApiKey } from '../src/app/db/entities/api-key.entity.js';
import { CreditTransaction } from '../src/app/db/entities/credit-transaction.entity.js';
import { ExternalEndpoint } from '../src/app/db/entities/external-endpoint.entity.js';
import { InviteCode } from '../src/app/db/entities/invite-code.entity.js';
import { InviteRedemption } from '../src/app/db/entities/invite-redemption.entity.js';
import { TrustedMeasurement } from '../src/app/db/entities/trusted-measurement.entity.js';
import { User } from '../src/app/db/entities/user.entity.js';
import { Workspace } from '../src/app/db/entities/workspace.entity.js';
import { createHarness, type Harness, signUpWithCode } from './app-harness.js';
import { type ConsoleSession, dataSourceOf, expectData, graphql } from './console.js';

/**
 * The redeploy migration path, end to end over two real deployments (SUP-271):
 * deployment A is used — invited sign-ups, spent credit, codes left over — and
 * exported; deployment B is claimed fresh and takes the file. What has to hold
 * afterwards is what an operator would check by hand: the same people, the same
 * balances, the same codes, nobody's chats or keys, and no credential anywhere
 * in the file.
 */

const BOOTSTRAP_TOKEN = 'bootstrap-token-'.padEnd(40, 'x');
const OPERATOR = 'admin@confidential-router.local';
const GRANT_MICROS = 25_000_000;
const SPENT_MICROS = 1_500_000;
const SEALED_UPSTREAM_KEY = 'v1.sealed-upstream-key-ciphertext';
const KEY_LIMIT_MICROS = 5_000_000;

const ISSUE = `
  mutation Issue($input: IssueInviteCodesInput!) {
    issueInviteCodes(input: $input) { codes { id code } }
  }
`;

const CREATE_KEY = `
  mutation CreateKey($input: CreateApiKeyInput!) {
    createApiKey(input: $input) { secret key { id prefix spendLimitMicros } }
  }
`;

const REVOKE_KEY = 'mutation Revoke($id: ID!) { revokeApiKey(id: $id) { id revokedAt } }';

const harnesses: Harness[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const harness of harnesses.splice(0)) {
    await harness.close();
  }
});

interface Deployment {
  harness: Harness;
  operator: ConsoleSession;
}

async function deploy(env: Record<string, string> = {}): Promise<Deployment> {
  const harness = await createHarness({
    env: {
      CR_API_AUTH__BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN,
      CR_API_AUTH__ADMIN_EMAILS: OPERATOR,
      ...env,
    },
  });
  harnesses.push(harness);
  const claimed = await request(harness.app.getHttpServer())
    .post('/auth/bootstrap')
    .send({ token: BOOTSTRAP_TOKEN })
    .expect(200);
  return { harness, operator: await sessionOf(harness, claimed) };
}

async function sessionOf(harness: Harness, response: request.Response): Promise<ConsoleSession> {
  const raw = response.headers['set-cookie'];
  const cookies = (Array.isArray(raw) ? raw : [raw].filter(Boolean)) as string[];
  const session = { harness, cookies, email: '', workspaceId: '' };
  const me = await graphql(session, '{ me { email workspaces { id } } }');
  return { ...session, email: me.data.me.email, workspaceId: me.data.me.workspaces[0].id };
}

async function signUp(harness: Harness, email: string, inviteCode?: string): Promise<ConsoleSession> {
  // By emailed code — the only way an account is created (SUP-269).
  const response = await signUpWithCode(harness, {
    email,
    name: email.split('@')[0],
    ...(inviteCode ? { inviteCode } : {}),
  }).expect(200);
  return sessionOf(harness, response);
}

function exportRequest(session: ConsoleSession) {
  return request(session.harness.app.getHttpServer())
    .get('/admin/data/export')
    .set('Cookie', session.cookies)
    .buffer(true)
    .parse((response, done) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => done(null, Buffer.concat(chunks)));
    });
}

async function exportFile(session: ConsoleSession): Promise<Buffer> {
  return (await exportRequest(session).expect(200)).body as Buffer;
}

function importRequest(session: ConsoleSession, file: Buffer, query: Record<string, string> = {}) {
  return request(session.harness.app.getHttpServer())
    .post('/admin/data/import')
    .query(query)
    .set('Cookie', session.cookies)
    .set('Content-Type', DATA_EXPORT_CONTENT_TYPE)
    .send(file);
}

async function dryRun(session: ConsoleSession, file: Buffer): Promise<ImportReport> {
  return (await importRequest(session, file).expect(200)).body;
}

async function apply(session: ConsoleSession, file: Buffer, expectSha: string): Promise<ImportReport> {
  return (await importRequest(session, file, { apply: 'true', expect: expectSha }).expect(200)).body;
}

function section(report: ImportReport, name: string) {
  const found = report.sections.find((entry) => entry.section === name);
  if (!found) {
    throw new Error(`No ${name} section in the report.`);
  }
  return found;
}

interface Used {
  a: Deployment;
  users: ConsoleSession[];
  codes: { id: string; code: string }[];
  spender: ConsoleSession;
  /** A live key with a spend limit, and one the user revoked. Plaintext included. */
  keys: { live: MintedKey; revoked: MintedKey };
}

interface MintedKey {
  id: string;
  secret: string;
}

async function mintKey(session: ConsoleSession, name: string, spendLimitMicros?: number): Promise<MintedKey> {
  const created = await expectData(session, CREATE_KEY, {
    input: {
      workspaceId: session.workspaceId,
      name,
      ...(spendLimitMicros === undefined ? {} : { spendLimitMicros: String(spendLimitMicros) }),
    },
  });
  return { id: created.createApiKey.key.id, secret: created.createApiKey.secret };
}

/** Deployment A after a small life: three invited accounts, one of which spent, and two codes left over. */
async function usedDeployment(): Promise<Used> {
  const a = await deploy();
  const issued = await expectData(a.operator, ISSUE, {
    input: { count: 5, grantMicros: String(GRANT_MICROS), campaign: 'launch-2026-10' },
  });
  const codes: { id: string; code: string }[] = issued.issueInviteCodes.codes;

  const users: ConsoleSession[] = [];
  for (const [index, name] of ['ada', 'bo', 'cy'].entries()) {
    users.push(await signUp(a.harness, `${name}@example.test`, codes[index]?.code));
  }
  const spender = users[0] as ConsoleSession;
  await a.harness.app.get(LedgerService).record({
    workspaceId: spender.workspaceId,
    kind: 'usage',
    amountMicros: -SPENT_MICROS,
    idempotencyKey: 'usage:gen-0001',
    reference: 'gen-0001',
  });

  // The credentials a user configured elsewhere: one live, one they revoked.
  // Minted through the console, so the plaintext is the real thing a Gatekeeper
  // would be holding — which is what the import has to keep working (SUP-445).
  const dataSource = dataSourceOf(a.harness);
  const live = await mintKey(spender, 'Gatekeeper', KEY_LIMIT_MICROS);
  const revoked = await mintKey(spender, 'Retired');
  await expectData(spender, REVOKE_KEY, { id: revoked.id });
  await dataSource.getRepository(ApiKey).update({ id: live.id }, { spentTotalMicros: SPENT_MICROS });

  // Things that must stay behind: an upstream's sealed key.
  await dataSource.getRepository(ExternalEndpoint).insert({
    id: randomUUID(),
    name: 'partner-cloud',
    baseUrl: 'https://llm.partner.example/v1',
    hostname: 'llm.partner.example',
    listenPort: 15001,
    enabled: true,
    status: 'verified',
    measurementSeen: 'ab'.repeat(32),
    pinnedEvidenceDigest: 'sha256/approved-deployment',
    apiKeyCiphertext: SEALED_UPSTREAM_KEY,
    apiKeyPrefix: 'sk-part',
    createdByUserId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await dataSource.getRepository(TrustedMeasurement).insert({
    id: randomUUID(),
    measurement: 'cd'.repeat(32),
    note: 'partner cloud',
    addedByUserId: null,
    addedAt: new Date(),
  });
  return { a, users, codes, spender, keys: { live, revoked } };
}

/** `GET /v1/models` behind the key guard: the cheapest question that is really "does this key work?". */
function callWithKey(harness: Harness, secret: string) {
  return request(harness.app.getHttpServer()).get('/v1/models').set('Authorization', `Bearer ${secret}`);
}

async function balancesByEmail(harness: Harness): Promise<Map<string, number>> {
  const rows: { email: string; balanceMicros: string | number }[] = await dataSourceOf(harness).query(
    'SELECT u."email" AS "email", w."balanceMicros" AS "balanceMicros" FROM "user" u ' +
      'JOIN "workspace_members" m ON m."userId" = u."id" JOIN "workspaces" w ON w."id" = m."workspaceId"',
  );
  return new Map(rows.map((row) => [row.email, Number(row.balanceMicros)]));
}

describe('deployment export', () => {
  it('is refused to anyone who is not an operator, and is never cached', async () => {
    const { a, users } = await usedDeployment();
    const server = a.harness.app.getHttpServer();

    await request(server).get('/admin/data/export').expect(401);
    await exportRequest(users[0] as ConsoleSession).expect(403);
    await importRequest(users[0] as ConsoleSession, Buffer.from('x')).expect(403);
    await request(server)
      .post('/admin/data/import')
      .set('Content-Type', DATA_EXPORT_CONTENT_TYPE)
      .send('x')
      .expect(401);

    const response = await exportRequest(a.operator).expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-type']).toContain(DATA_EXPORT_CONTENT_TYPE);
    expect(response.headers['content-disposition']).toMatch(
      /attachment; filename="router-export-\d{8}-\d{4}-.+\.json\.gz"/,
    );
  });

  it('carries the accounts, ledger, codes and trust config, with a manifest that matches', async () => {
    const { a, codes, spender } = await usedDeployment();
    const bundle = decodeBundle(await exportFile(a.operator));

    expect(bundle.format).toBe('router-export');
    expect(bundle.schemaVersion).toBe(1);
    expect(bundle.counts).toMatchObject({
      users: 4,
      workspaces: 4,
      workspaceMembers: 4,
      inviteCampaigns: 1,
      inviteCodes: 5,
      inviteCodesUnredeemed: 2,
      inviteRedemptions: 3,
      externalEndpoints: 1,
      trustedMeasurements: 1,
      apiKeys: 2,
      apiKeysLive: 1,
    });
    // Three invitation grants and one debit.
    expect(bundle.counts.creditEntries).toBe(4);
    expect(bundle.totalBalanceMicros).toBe(String(3 * GRANT_MICROS - SPENT_MICROS));

    const spenderRow = bundle.data.users.find((user) => user.email === spender.email);
    expect(spenderRow).toMatchObject({ origin: 'invite', role: 'user', invitedByCodeId: codes[0]?.id });
    expect(bundle.data.users.find((user) => user.email === OPERATOR)).toMatchObject({
      origin: 'bootstrap',
      role: 'admin',
      invitedByCodeId: null,
    });
    // Unredeemed codes are in the file in full: surviving the redeploy is the point of them.
    expect(bundle.data.inviteCodes.filter((code) => code.status === 'unredeemed')).toHaveLength(2);
    expect(bundle.data.externalEndpoints[0]).toMatchObject({
      name: 'partner-cloud',
      pinnedEvidenceDigest: 'sha256/approved-deployment',
    });
  });

  it('holds no password, session token, key plaintext or sealed upstream key — and no chats', async () => {
    const { a, keys } = await usedDeployment();
    const file = await exportFile(a.operator);
    const text = gunzipSync(file).toString('utf8');
    const bundle = JSON.parse(text) as ExportBundle;
    const dataSource = dataSourceOf(a.harness);

    // By name: nothing in the file is credential-shaped beyond the API-key
    // fields the guard excuses on purpose (SUP-445).
    expect(credentialShapedKeys(bundle)).toEqual([]);
    expect(Object.keys(bundle.data).sort()).toEqual([
      'apiKeys',
      'creditLedger',
      'externalEndpoints',
      'inviteCodes',
      'inviteRedemptions',
      'trustedMeasurements',
      'users',
      'workspaceMembers',
      'workspaces',
    ]);
    const excused = new Set(CARRIED_NON_CREDENTIAL_PATHS);
    for (const [name, rows] of Object.entries(bundle.data)) {
      for (const row of rows as Record<string, unknown>[]) {
        for (const key of Object.keys(row)) {
          const allowed = key === 'idempotencyKey' || excused.has(`${name}[].${key}`);
          expect(allowed || !CREDENTIAL_KEY_PATTERN.test(key), `${name}.${key}`).toBe(true);
        }
      }
    }

    // By value: the secrets this deployment really holds are not in the bytes.
    // There is no password hash among them to leak — accounts sign in with a
    // mailed code and none is stored (SUP-269) — so what is left to keep out is
    // the sessions, the pending sign-in codes, the sealed upstream key, and the
    // plaintext of an API key, which nothing on this deployment still has.
    const passwords: { password: string | null }[] = await dataSource.query('SELECT "password" FROM "account"');
    const sessions: { token: string }[] = await dataSource.query('SELECT "token" FROM "session"');
    const pendingCodes: { value: string }[] = await dataSource.query('SELECT "value" FROM "verification"');
    expect(passwords.filter((row) => row.password)).toEqual([]);
    expect(sessions.length).toBeGreaterThanOrEqual(4);
    for (const secret of [
      ...sessions.map((row) => row.token),
      ...pendingCodes.map((row) => row.value),
      keys.live.secret,
      keys.revoked.secret,
      SEALED_UPSTREAM_KEY,
    ]) {
      if (secret) {
        expect(text.includes(secret)).toBe(false);
      }
    }

    // What the keys section does carry: the stored hash, and nothing a reader
    // could turn back into the key above.
    const stored = await dataSource.getRepository(ApiKey).findOneByOrFail({ id: keys.live.id });
    expect(bundle.data.apiKeys.map((key) => key.id).sort()).toEqual([keys.live.id, keys.revoked.id].sort());
    expect(bundle.data.apiKeys.find((key) => key.id === keys.live.id)).toMatchObject({
      keyHash: stored.keyHash,
      prefix: stored.prefix,
      name: 'Gatekeeper',
      spendLimitMicros: String(KEY_LIMIT_MICROS),
      spentTotalMicros: String(SPENT_MICROS),
      revokedAt: null,
    });
    expect(bundle.data.apiKeys.find((key) => key.id === keys.revoked.id)?.revokedAt).not.toBeNull();
  });

  it('leaves an audit line that names the operator and the counts, never a code or an address', async () => {
    const { a, codes, users } = await usedDeployment();
    const lines: string[] = [];
    vi.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => {
      lines.push(String(message));
    });

    const file = await exportFile(a.operator);
    await dryRun(a.operator, file);

    const audit = lines.filter((line) => line.startsWith('Deployment '));
    expect(audit).toHaveLength(2);
    expect(audit[0]).toContain(`Deployment export downloaded by ${OPERATOR}`);
    expect(audit[0]).toContain('5 invitation code(s) (2 unredeemed)');
    expect(audit[0]).toContain('2 API key(s) (1 live)');
    expect(audit[1]).toContain(`Deployment import dry run by ${OPERATOR}`);
    for (const line of audit) {
      for (const code of codes) {
        expect(line).not.toContain(code.code);
        expect(line).not.toContain(code.code.replace(/-/g, ''));
      }
      for (const user of users) {
        expect(line).not.toContain(user.email);
      }
    }
  });
});

describe('deployment import', () => {
  it('moves a used deployment into a fresh one: same people, balances, attribution and codes', async () => {
    const { a, codes, users } = await usedDeployment();
    const file = await exportFile(a.operator);
    const exported = decodeBundle(file);
    const before = await balancesByEmail(a.harness);
    await a.harness.close();
    harnesses.splice(0);

    const b = await deploy();
    const target = dataSourceOf(b.harness);

    // The dry run says what would happen and writes nothing.
    const preview = await dryRun(b.operator, file);
    expect(preview).toMatchObject({ applied: false, ok: true, refusals: [] });
    expect(preview.contentSha256).toBe(exported.integrity.contentSha256);
    expect(preview.source).toEqual(exported.source);
    // The operator re-claimed B under a new id, so theirs is merged, not created.
    expect(section(preview, 'users')).toMatchObject({ inBundle: 4, toCreate: 3, alreadyPresent: 1, conflicts: [] });
    expect(section(preview, 'inviteCodes')).toMatchObject({ inBundle: 5, toCreate: 5 });
    expect(section(preview, 'creditLedger')).toMatchObject({ inBundle: 4, toCreate: 4 });
    expect(await target.getRepository(User).count()).toBe(1);
    expect(await target.getRepository(InviteCode).count()).toBe(0);
    expect(await target.getRepository(CreditTransaction).count()).toBe(0);

    // Importing takes the hash the dry run reported.
    await importRequest(b.operator, file, { apply: 'true' }).expect(400);
    expect(await target.getRepository(User).count()).toBe(1);

    const report = await apply(b.operator, file, preview.contentSha256);
    expect(report).toMatchObject({ applied: true, ok: true });

    // Counts match the manifest.
    expect(await target.getRepository(User).count()).toBe(exported.counts.users);
    expect(await target.getRepository(Workspace).count()).toBe(exported.counts.workspaces);
    expect(await target.getRepository(CreditTransaction).count()).toBe(exported.counts.creditEntries);
    expect(await target.getRepository(InviteCode).count()).toBe(exported.counts.inviteCodes);
    expect(await target.getRepository(InviteRedemption).count()).toBe(exported.counts.inviteRedemptions);
    expect(await target.getRepository(TrustedMeasurement).count()).toBe(1);

    // Balances, to the micro-dollar, and each equal to its ledger.
    expect(await balancesByEmail(b.harness)).toEqual(before);
    const sums: { total: string | number }[] = await target.query(
      'SELECT SUM("amountMicros") AS "total" FROM "credit_transactions"',
    );
    expect(String(sums[0]?.total)).toBe(exported.totalBalanceMicros);

    // The keys came across, and nothing that was left out arrived.
    expect(await target.getRepository(ApiKey).count()).toBe(exported.counts.apiKeys);
    const accounts: { n: number }[] = await target.query('SELECT COUNT(*) AS "n" FROM "account"');
    expect(Number(accounts[0]?.n)).toBe(0);

    // The upstream is there, switched off, with no key to open.
    expect(await target.getRepository(ExternalEndpoint).findOneByOrFail({ name: 'partner-cloud' })).toMatchObject({
      enabled: false,
      status: 'disabled',
      apiKeyCiphertext: '',
      measurementSeen: null,
      pinnedEvidenceDigest: 'sha256/approved-deployment',
    });
    expect(report.notes.join(' ')).toContain('without an upstream API key');

    // An imported account carries no credential of any kind — and there is no
    // password for anyone to have set on it in the meantime (SUP-269). Its owner
    // proves the address again with a mailed code, and lands in the account that
    // was carried over rather than in a new one.
    const ada = users[0] as ConsoleSession;
    for (const path of ['/auth/sign-in/email', '/auth/sign-up/email']) {
      await request(b.harness.app.getHttpServer())
        .post(path)
        .send({ email: ada.email, password: 'somebody-elses-password', name: 'not ada' })
        .expect(404);
    }
    const back = await sessionOf(b.harness, await signUpWithCode(b.harness, { email: ada.email }).expect(200));
    expect(back.workspaceId).toBe(ada.workspaceId);
    const credits = await expectData(back, '{ me { email workspaces { id } } }');
    expect(credits.me.email).toBe(ada.email);

    // Attribution survives: the admin list still says who came from which code.
    const signUps = await expectData(b.operator, '{ adminSignUps { nodes { email origin inviteCodeId campaign } } }');
    expect(signUps.adminSignUps.nodes.find((node: { email: string }) => node.email === ada.email)).toMatchObject({
      origin: 'INVITE',
      inviteCodeId: codes[0]?.id,
      campaign: 'launch-2026-10',
    });
    // And so does the operator's own origin: the import wrote A's accounts under
    // timestamps older than B's claim, which used to make the administrator the
    // latest row here and read as an open sign-up on an invite-only deployment
    // (SUP-309).
    expect(signUps.adminSignUps.nodes.find((node: { email: string }) => node.email === OPERATOR)).toMatchObject({
      origin: 'BOOTSTRAP',
      inviteCodeId: null,
    });

    // An unredeemed code still works here; a spent one still does not.
    const dee = await signUp(b.harness, 'dee@example.test', codes[3]?.code);
    expect((await balancesByEmail(b.harness)).get(dee.email)).toBe(GRANT_MICROS);
    const eve = await signUp(b.harness, 'eve@example.test', codes[0]?.code);
    expect((await balancesByEmail(b.harness)).get(eve.email)).toBe(0);
  });

  it('keeps a key minted before the export working after the import, limit and all', async () => {
    // The rebuild drill SUP-445 asks for, and the reason the section exists: a
    // tester whose Gatekeeper holds this secret must not meet a 401 because an
    // operator replaced the deployment.
    const { a, keys, spender } = await usedDeployment();
    const file = await exportFile(a.operator);
    const sha = decodeBundle(file).integrity.contentSha256;
    await callWithKey(a.harness, keys.live.secret).expect(200);
    await a.harness.close();
    harnesses.splice(0);

    const b = await deploy();
    const report = await apply(b.operator, file, sha);

    expect(report).toMatchObject({ applied: true, ok: true });
    expect(section(report, 'apiKeys')).toMatchObject({ inBundle: 2, toCreate: 2, conflicts: [] });
    expect(report.notes.join(' ')).toContain('2 API key(s) are imported, 1 of them still live');

    // The same plaintext, against a deployment that has never seen it before.
    await callWithKey(b.harness, keys.live.secret).expect(200);
    // And the state that travelled with it: the limit, the counter that limit is
    // measured against, the workspace it bills, and the revocation of the other.
    const imported = await dataSourceOf(b.harness).getRepository(ApiKey).findOneByOrFail({ id: keys.live.id });
    expect(imported).toMatchObject({
      workspaceId: spender.workspaceId,
      name: 'Gatekeeper',
      spendLimitMicros: KEY_LIMIT_MICROS,
      spentTotalMicros: SPENT_MICROS,
      revokedAt: null,
    });
    const refused = await callWithKey(b.harness, keys.revoked.secret).expect(401);
    expect(refused.body.error.code).toBe('api_key_revoked');
    // A key this deployment never had is still nobody's.
    await callWithKey(b.harness, `sk-tee-v1-${'z'.repeat(43)}`).expect(401);
  });

  it('is idempotent: importing the same file again creates nothing and changes no balance', async () => {
    const { a } = await usedDeployment();
    const file = await exportFile(a.operator);
    const sha = decodeBundle(file).integrity.contentSha256;
    await a.harness.close();
    harnesses.splice(0);

    const b = await deploy();
    await apply(b.operator, file, sha);
    const balances = await balancesByEmail(b.harness);
    const ledger = await dataSourceOf(b.harness).getRepository(CreditTransaction).count();

    const again = await apply(b.operator, file, sha);
    expect(again).toMatchObject({ applied: true, ok: true });
    for (const entry of again.sections) {
      expect(entry, entry.section).toMatchObject({ toCreate: 0, alreadyPresent: entry.inBundle, conflicts: [] });
    }
    expect(await balancesByEmail(b.harness)).toEqual(balances);
    expect(await dataSourceOf(b.harness).getRepository(CreditTransaction).count()).toBe(ledger);
  });

  it('refuses a deployment somebody has already signed up to, and writes nothing', async () => {
    const { a } = await usedDeployment();
    const file = await exportFile(a.operator);
    const sha = decodeBundle(file).integrity.contentSha256;
    await a.harness.close();
    harnesses.splice(0);

    const b = await deploy();
    await signUp(b.harness, 'early-bird@example.test');
    const target = dataSourceOf(b.harness);
    const usersBefore = await target.getRepository(User).count();

    const preview = await dryRun(b.operator, file);
    expect(preview).toMatchObject({ applied: false, ok: false });
    expect(preview.refusals.join(' ')).toContain('This deployment is not fresh: 1 account(s)');

    const report = await apply(b.operator, file, sha);
    expect(report).toMatchObject({ applied: false, ok: false });
    expect(await target.getRepository(User).count()).toBe(usersBefore);
    expect(await target.getRepository(InviteCode).count()).toBe(0);
    expect(await target.getRepository(CreditTransaction).count()).toBe(0);
  });

  it('refuses a file that is not an export, was edited, or is a version it does not know', async () => {
    const { a } = await usedDeployment();
    const file = await exportFile(a.operator);
    const bundle = JSON.parse(gunzipSync(file).toString('utf8')) as ExportBundle;
    const repack = (value: unknown): Buffer => gzipSync(Buffer.from(JSON.stringify(value), 'utf8'));
    const refused = async (upload: Buffer): Promise<string> =>
      (await importRequest(a.operator, upload).expect(400)).body.message;

    expect(await refused(Buffer.from('not a gzip file'))).toContain('not a gzip archive');
    expect(await refused(repack({ hello: 'world' }))).toContain('not a router export');
    expect(await refused(repack({ ...bundle, schemaVersion: 2 }))).toContain('schema version 2');

    // A balance edited by hand no longer matches the hash the file carries.
    const edited = structuredClone(bundle);
    (edited.data.workspaces[0] as { balanceMicros: string }).balanceMicros = '999000000';
    expect(await refused(repack(edited))).toContain('do not match its own SHA-256');

    // A file that tries to carry a credential in is refused by name.
    const smuggled = structuredClone(bundle) as ExportBundle & { data: { users: Record<string, unknown>[] } };
    (smuggled.data.users[0] as Record<string, unknown>).passwordHash = 'x';
    expect(await refused(repack(smuggled))).toContain('credential-shaped');

    // And a JSON body is not an upload at all.
    await request(a.harness.app.getHttpServer())
      .post('/admin/data/import')
      .set('Cookie', a.operator.cookies)
      .send({ format: 'router-export' })
      .expect(400);
  });
});
