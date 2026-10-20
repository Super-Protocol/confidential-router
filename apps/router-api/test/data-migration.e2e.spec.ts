import { randomUUID } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generationLedgerKey, LedgerService } from '../src/app/billing/index.js';
import {
  CREDENTIAL_KEY_PATTERN,
  contentSha256,
  credentialShapedKeys,
  DATA_EXPORT_CONTENT_TYPE,
  decodeBundle,
  type ExportBundle,
  type ImportReport,
  isPerGenerationUsage,
} from '../src/app/data-migration/index.js';
import { ApiKey } from '../src/app/db/entities/api-key.entity.js';
import { CreditTransaction } from '../src/app/db/entities/credit-transaction.entity.js';
import { ExternalEndpoint } from '../src/app/db/entities/external-endpoint.entity.js';
import { Generation } from '../src/app/db/entities/generation.entity.js';
import { InviteCode } from '../src/app/db/entities/invite-code.entity.js';
import { InviteRedemption } from '../src/app/db/entities/invite-redemption.entity.js';
import { Model } from '../src/app/db/entities/model.entity.js';
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
/** Three metered requests on deployment A, one ledger debit each. */
const SPEND_PER_REQUEST_MICROS = [600_000, 500_000, 400_000];
const SPENT_MICROS = SPEND_PER_REQUEST_MICROS.reduce((sum, micros) => sum + micros, 0);
const MODEL_ID = 'fixture/chat';
/** `carried-usage:<yyyy-mm>:<workspaceId>` — the month is the run's own, so it is matched, not spelled. */
const carriedKey = (workspaceId: string): RegExp => new RegExp(`^carried-usage:\\d{4}-\\d\\d:${workspaceId}$`);
const SEALED_UPSTREAM_KEY = 'v1.sealed-upstream-key-ciphertext';
const API_KEY_HASH = 'a1b2c3d4'.repeat(8);

const ISSUE = `
  mutation Issue($input: IssueInviteCodesInput!) {
    issueInviteCodes(input: $input) { codes { id code } }
  }
`;

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
    // One endpoint and one model, so a metered request can be written as the
    // generation row it really is — `generations.modelId` is a foreign key.
    config: {
      version: 1,
      endpoints: [{ name: 'fixture', hostname: 'fixture.router.test' }],
      models: [
        {
          id: MODEL_ID,
          name: 'Fixture Chat',
          litellmModel: 'fixture-chat',
          endpoint: 'fixture',
          contextLength: 4096,
          capabilities: ['chat'],
          pricing: { promptPer1mMicros: 1_000_000, completionPer1mMicros: 2_000_000 },
        },
      ],
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
  const dataSource = dataSourceOf(a.harness);

  // Things that must stay behind: an API key, and an upstream's sealed key.
  const apiKeyId = randomUUID();
  await dataSource.getRepository(ApiKey).insert({
    id: apiKeyId,
    workspaceId: spender.workspaceId,
    name: 'Production',
    keyHash: API_KEY_HASH,
    prefix: 'sk-tee-v1-4f',
    modelScope: null,
    spentTotalMicros: 0,
    createdByUserId: spender.email,
    createdAt: new Date(),
  });

  // The spend as the router really writes it: a generation row per metered
  // request, and a usage debit naming it (SUP-446).
  await meter(a.harness, spender.workspaceId, { apiKeyId, prefix: 'a', costsMicros: SPEND_PER_REQUEST_MICROS });
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
  return { a, users, codes, spender };
}

/**
 * Metered requests as the gateway writes them: a `generations` row each, and the
 * usage debit that names it. Written here rather than driven through `/v1`
 * because what this suite is about is which of the two crosses a migration.
 */
async function meter(
  harness: Harness,
  workspaceId: string,
  options: { apiKeyId?: string | null; prefix: string; costsMicros: readonly number[] },
): Promise<void> {
  const dataSource = dataSourceOf(harness);
  const model = await dataSource.getRepository(Model).findOneByOrFail({ id: MODEL_ID });
  const ledger = harness.app.get(LedgerService);

  for (const [index, costMicros] of options.costsMicros.entries()) {
    const generationId = `gen-${options.prefix}-${index + 1}`;
    await dataSource.getRepository(Generation).insert({
      id: generationId,
      workspaceId,
      apiKeyId: options.apiKeyId ?? null,
      modelId: model.id,
      endpointId: model.endpointId,
      externalEndpointId: null,
      evidenceSnapshotId: null,
      evidenceDigest: null,
      promptTokens: 100,
      completionTokens: 200,
      costMicros,
      promptPer1mMicros: model.promptPer1mMicros,
      completionPer1mMicros: model.completionPer1mMicros,
      streamed: false,
      status: 'ok',
      createdAt: new Date(Date.parse('2026-10-19T12:00:00.000Z') + index * 60_000),
    });
    await ledger.debitGeneration({ workspaceId, generationId, amountMicros: costMicros });
  }
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
    });
    // Three invitation grants, and the spender's three metered requests carried
    // as the one debit they are allowed to cross as (SUP-446).
    expect(bundle.counts.creditEntries).toBe(4);
    expect(bundle.totalBalanceMicros).toBe(String(3 * GRANT_MICROS - SPENT_MICROS));
    expect(bundle.data.creditLedger.filter(isPerGenerationUsage)).toEqual([]);
    expect(bundle.data.creditLedger.find((entry) => entry.kind === 'usage')).toMatchObject({
      workspaceId: spender.workspaceId,
      amountMicros: String(-SPENT_MICROS),
      // No reference to a generation the file does not carry — the defect.
      reference: null,
      idempotencyKey: expect.stringMatching(carriedKey(spender.workspaceId)),
    });
    expect(bundle.data.creditLedger.find((entry) => entry.kind === 'usage')?.description).toMatch(
      /^Metered usage carried over from \S+: 3 requests served in \d{4}-\d\d\. /,
    );

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

  it('holds no password hash, session token, API key or sealed upstream key — and no chats', async () => {
    const { a } = await usedDeployment();
    const file = await exportFile(a.operator);
    const text = gunzipSync(file).toString('utf8');
    const bundle = JSON.parse(text) as ExportBundle;
    const dataSource = dataSourceOf(a.harness);

    // By name: no field anywhere in the file is credential-shaped.
    expect(credentialShapedKeys(bundle)).toEqual([]);
    expect(Object.keys(bundle.data).sort()).toEqual([
      'creditLedger',
      'externalEndpoints',
      'inviteCodes',
      'inviteRedemptions',
      'trustedMeasurements',
      'users',
      'workspaceMembers',
      'workspaces',
    ]);
    for (const [name, rows] of Object.entries(bundle.data)) {
      for (const row of rows as Record<string, unknown>[]) {
        for (const key of Object.keys(row)) {
          expect(key === 'idempotencyKey' || !CREDENTIAL_KEY_PATTERN.test(key), `${name}.${key}`).toBe(true);
        }
      }
    }

    // By value: the secrets this deployment really holds are not in the bytes.
    // There is no password hash among them to leak — accounts sign in with a
    // mailed code and none is stored (SUP-269) — so what is left to keep out is
    // the sessions, the pending sign-in codes, and the two kinds of key.
    const passwords: { password: string | null }[] = await dataSource.query('SELECT "password" FROM "account"');
    const sessions: { token: string }[] = await dataSource.query('SELECT "token" FROM "session"');
    const pendingCodes: { value: string }[] = await dataSource.query('SELECT "value" FROM "verification"');
    expect(passwords.filter((row) => row.password)).toEqual([]);
    expect(sessions.length).toBeGreaterThanOrEqual(4);
    for (const secret of [
      ...sessions.map((row) => row.token),
      ...pendingCodes.map((row) => row.value),
      API_KEY_HASH,
      SEALED_UPSTREAM_KEY,
    ]) {
      if (secret) {
        expect(text.includes(secret)).toBe(false);
      }
    }
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

    // Nothing that was left out arrived, and no credential was invented.
    expect(await target.getRepository(ApiKey).count()).toBe(0);
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

    // An unredeemed code still works here; a spent one still does not.
    const dee = await signUp(b.harness, 'dee@example.test', codes[3]?.code);
    expect((await balancesByEmail(b.harness)).get(dee.email)).toBe(GRANT_MICROS);
    const eve = await signUp(b.harness, 'eve@example.test', codes[0]?.code);
    expect((await balancesByEmail(b.harness)).get(eve.email)).toBe(0);
  });

  it('leaves the generation log behind without leaving a charge for a request nobody can see (SUP-446)', async () => {
    const { a, spender } = await usedDeployment();
    const source = dataSourceOf(a.harness);
    // What deployment A really holds: three requests in the log, three debits.
    expect(await source.getRepository(Generation).count()).toBe(3);
    expect(
      await source.getRepository(CreditTransaction).countBy({ workspaceId: spender.workspaceId, kind: 'usage' }),
    ).toBe(3);

    const file = await exportFile(a.operator);
    const sha = decodeBundle(file).integrity.contentSha256;
    await a.harness.close();
    harnesses.splice(0);

    const b = await deploy();
    const report = await apply(b.operator, file, sha);
    expect(report).toMatchObject({ applied: true, ok: true });

    const target = dataSourceOf(b.harness);
    // The log stayed behind — it always did, and that is the design.
    expect(await target.getRepository(Generation).count()).toBe(0);

    // What must not have come across with it: a usage debit naming one of those
    // rows. Before SUP-446 all three did, and the workspace was billed $1.50 for
    // traffic its Logs and Activity screens could not show.
    const usage = await target
      .getRepository(CreditTransaction)
      .findBy({ workspaceId: spender.workspaceId, kind: 'usage' });
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      amountMicros: -SPENT_MICROS,
      reference: null,
      idempotencyKey: expect.stringMatching(carriedKey(spender.workspaceId)),
    });
    expect(usage[0]?.description).toMatch(/3 requests served in \d{4}-\d\d/);
    for (const generationId of ['gen-a-1', 'gen-a-2', 'gen-a-3']) {
      expect(
        await target.getRepository(CreditTransaction).countBy({ idempotencyKey: generationLedgerKey(generationId) }),
      ).toBe(0);
    }

    // And the money is untouched: the balance is still the sum of the ledger.
    const balances = await balancesByEmail(b.harness);
    expect(balances.get(spender.email)).toBe(GRANT_MICROS - SPENT_MICROS);
  });

  it('repairs a bundle written before SUP-446 instead of refusing it', async () => {
    const { a, spender } = await usedDeployment();
    const file = await exportFile(a.operator);
    const bundle = JSON.parse(gunzipSync(file).toString('utf8')) as ExportBundle;
    await a.harness.close();
    harnesses.splice(0);

    // The ledger section an older build would have written: one debit per
    // request, each naming its generation.
    const carried = bundle.data.creditLedger.findIndex((entry) => entry.kind === 'usage');
    bundle.data.creditLedger.splice(
      carried,
      1,
      ...SPEND_PER_REQUEST_MICROS.map((micros, index) => ({
        id: `tx-gen-${index + 1}`,
        workspaceId: spender.workspaceId,
        kind: 'usage' as const,
        amountMicros: String(-micros),
        reference: `gen-a-${index + 1}`,
        description: null,
        idempotencyKey: generationLedgerKey(`gen-a-${index + 1}`),
        createdAt: '2026-10-19T12:00:00.000Z',
      })),
    );
    const legacy = {
      ...bundle,
      counts: { ...bundle.counts, creditEntries: bundle.counts.creditEntries + 2 },
      integrity: { contentSha256: '' },
    };
    legacy.integrity.contentSha256 = contentSha256(legacy.data);
    const upload = gzipSync(Buffer.from(JSON.stringify(legacy), 'utf8'));

    const b = await deploy();
    const preview = await dryRun(b.operator, upload);
    expect(preview).toMatchObject({ applied: false, ok: true, refusals: [] });
    expect(preview.notes.join(' ')).toContain('3 per-request usage debit(s)');

    const report = await apply(b.operator, upload, preview.contentSha256);
    expect(report).toMatchObject({ applied: true, ok: true });

    const usage = await dataSourceOf(b.harness)
      .getRepository(CreditTransaction)
      .findBy({ workspaceId: spender.workspaceId, kind: 'usage' });
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ amountMicros: -SPENT_MICROS, reference: null });
    expect((await balancesByEmail(b.harness)).get(spender.email)).toBe(GRANT_MICROS - SPENT_MICROS);
  });

  it('migrates a deployment that was itself imported into, without a second carried entry', async () => {
    const { a, spender } = await usedDeployment();
    const first = await exportFile(a.operator);
    const firstSha = decodeBundle(first).integrity.contentSha256;
    await a.harness.close();
    harnesses.splice(0);

    const b = await deploy();
    expect(await apply(b.operator, first, firstSha)).toMatchObject({ applied: true, ok: true });
    // B serves traffic of its own, and is then migrated on in turn.
    const spentOnB = 250_000;
    await meter(b.harness, spender.workspaceId, { prefix: 'b', costsMicros: [spentOnB] });
    const second = await exportFile(b.operator);
    const secondBundle = decodeBundle(second);
    await b.harness.close();
    harnesses.splice(0);

    // One carried entry, not two under the same id — the file is importable.
    const usageInBundle = secondBundle.data.creditLedger.filter((entry) => entry.kind === 'usage');
    expect(usageInBundle).toHaveLength(1);
    expect(usageInBundle[0]).toMatchObject({
      id: expect.stringMatching(carriedKey(spender.workspaceId)),
      amountMicros: String(-(SPENT_MICROS + spentOnB)),
      reference: null,
    });
    // One request of B's own beside the inherited total: the count is what this
    // deployment served, and the rest is said in words (CTO follow-up 2).
    expect(usageInBundle[0]?.description).toContain('plus usage carried from an earlier migration');
    expect(usageInBundle[0]?.description).toMatch(/1 request served in \d{4}-\d\d/);

    const c = await deploy();
    const report = await apply(c.operator, second, secondBundle.integrity.contentSha256);
    expect(report).toMatchObject({ applied: true, ok: true, refusals: [] });
    expect(await dataSourceOf(c.harness).getRepository(Generation).count()).toBe(0);
    expect((await balancesByEmail(c.harness)).get(spender.email)).toBe(GRANT_MICROS - SPENT_MICROS - spentOnB);
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
