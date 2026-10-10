import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseCsv } from '../src/app/activity/csv.js';
import { InviteCarriedRedemption } from '../src/app/db/entities/invite-carried-redemption.entity.js';
import { InviteCode } from '../src/app/db/entities/invite-code.entity.js';
import { INVITE_CODES_CSV_HEADER, normaliseInviteCode } from '../src/app/invites/index.js';
import { createHarness, type Harness } from './app-harness.js';
import { anonymous, type ConsoleSession, dataSourceOf, expectData, graphql } from './console.js';

/**
 * The invitation codes CSV, end to end (SUP-272): an operator exports the Codes
 * tab from one deployment and imports the file into a fresh one — where the
 * unredeemed codes redeem, the redeemed and withdrawn ones are refused, and the
 * numbers are the ones the dry run promised.
 *
 * Two real applications on two databases, because "survives a redeploy" is a
 * claim about the second one.
 */

const BOOTSTRAP_TOKEN = 'bootstrap-token-'.padEnd(40, 'x');
const OPERATOR = 'admin@confidential-router.local';
const PASSWORD = 'correct-horse-battery';
const OLD_LANDING = 'https://old.router.example.com';
const NEW_LANDING = 'https://router.superprotocol.com';
const GRANT_MICROS = '25000000';
const EXPORT = '/admin/invite-codes/export.csv';
const IMPORT = '/admin/invite-codes/import';

const ISSUE = `
  mutation Issue($input: IssueInviteCodesInput!) {
    issueInviteCodes(input: $input) { codes { id code url } }
  }
`;
const CODES = `
  query Codes($status: InviteCodeStatus) {
    adminInviteCodes(status: $status, limit: 200) {
      totalCount
      nodes {
        code url campaign grantMicros maxRedemptions redemptionCount status note issuedByEmail
        redeemers { userId email redeemedAt carried }
      }
    }
  }
`;
const WITHDRAW = 'mutation Withdraw($id: ID!) { withdrawInviteCode(id: $id) { withdrawn } }';
const GRANT = '{ inviteGrant { campaign grantMicros } }';

interface Deployment {
  harness: Harness;
  operator: ConsoleSession;
}

const open: Harness[] = [];

async function deploy(landing: string): Promise<Deployment> {
  const harness = await createHarness({
    env: {
      CR_API_AUTH__PASSWORD__ENABLED: 'true',
      CR_API_AUTH__BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN,
      CR_API_AUTH__ADMIN_EMAILS: OPERATOR,
      CR_API_INVITES__LANDING_BASE_URL: landing,
    },
  });
  open.push(harness);
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
  const response = await request(harness.app.getHttpServer())
    .post('/auth/sign-up/email')
    .send({ email, password: PASSWORD, name: email.split('@')[0], ...(inviteCode ? { inviteCode } : {}) })
    .expect(200);
  return sessionOf(harness, response);
}

async function issue(
  { operator }: Deployment,
  count: number,
  extra: Record<string, unknown> = {},
): Promise<{ id: string; code: string; url: string }[]> {
  const data = await expectData(operator, ISSUE, {
    input: { count, grantMicros: GRANT_MICROS, campaign: 'launch-2026-10', ...extra },
  });
  return data.issueInviteCodes.codes;
}

function exportCsv(session: ConsoleSession, query: Record<string, string> = {}) {
  return request(session.harness.app.getHttpServer()).get(EXPORT).query(query).set('Cookie', session.cookies);
}

function importCsv(session: ConsoleSession, csv: string, query: Record<string, string> = {}) {
  return request(session.harness.app.getHttpServer())
    .post(IMPORT)
    .query(query)
    .set('Cookie', session.cookies)
    .set('Content-Type', 'text/csv')
    .send(csv);
}

/** The file as records keyed by column, the header aside. */
function recordsOf(csv: string): Record<(typeof INVITE_CODES_CSV_HEADER)[number], string>[] {
  const [header, ...rows] = parseCsv(csv);
  return rows.map((row) => Object.fromEntries(header.map((name, index) => [name, row[index]]))) as never;
}

function codeCount(harness: Harness): Promise<number> {
  return dataSourceOf(harness).getRepository(InviteCode).count();
}

/**
 * A deployment that has been used: two unredeemed codes, one redeemed, one
 * withdrawn, and a shared code with one of its three seats taken.
 */
async function usedDeployment() {
  const source = await deploy(OLD_LANDING);
  const [live, spare, redeemed, withdrawn] = await issue(source, 4, { note: 'First mailing' });
  const [shared] = await issue(source, 1, { campaign: 'partners', maxRedemptions: 3 });
  await signUp(source.harness, 'redeemer@example.com', redeemed.code);
  await signUp(source.harness, 'partner@example.com', shared.code);
  await expectData(source.operator, WITHDRAW, { id: withdrawn.id });
  return { source, live, spare, redeemed, withdrawn, shared };
}

beforeEach(() => {
  open.length = 0;
});

afterEach(async () => {
  vi.restoreAllMocks();
  // Newest first: each harness restores the environment it found.
  for (const harness of open.reverse()) {
    await harness.close();
  }
});

describe('exporting the codes', () => {
  it('exports every code with its full value, link, terms and standing', async () => {
    const { source, live, redeemed, withdrawn, shared } = await usedDeployment();

    const response = await exportCsv(source.operator).expect(200);

    expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(response.headers['content-disposition']).toMatch(
      /^attachment; filename="invite-codes-all-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    expect(response.headers['cache-control']).toBe('no-store');
    expect(parseCsv(response.text)[0]).toEqual([...INVITE_CODES_CSV_HEADER]);

    const byCode = new Map(recordsOf(response.text).map((record) => [record.code, record]));
    expect(byCode.size).toBe(5);
    expect(byCode.get(live.code)).toMatchObject({
      url: live.url,
      campaign: 'launch-2026-10',
      grantUsd: '25',
      status: 'active',
      redeemedByEmail: '',
      redeemedAt: '',
      maxRedemptions: '1',
      note: 'First mailing',
    });
    expect(byCode.get(redeemed.code)).toMatchObject({ status: 'redeemed', redeemedByEmail: 'redeemer@example.com' });
    expect(Date.parse(byCode.get(redeemed.code)?.redeemedAt ?? '')).not.toBeNaN();
    expect(byCode.get(withdrawn.code)).toMatchObject({ status: 'withdrawn' });
    expect(Date.parse(byCode.get(withdrawn.code)?.withdrawnAt ?? '')).not.toBeNaN();
    expect(byCode.get(shared.code)).toMatchObject({
      status: 'active',
      campaign: 'partners',
      maxRedemptions: '3',
      redeemedByEmail: 'partner@example.com',
    });
  });

  it('exports what the tab’s filter shows, and only that', async () => {
    const { source, redeemed, shared } = await usedDeployment();

    const byStatus = await exportCsv(source.operator, { status: 'redeemed' }).expect(200);
    const byCampaign = await exportCsv(source.operator, { campaign: 'partners' }).expect(200);
    const both = await exportCsv(source.operator, { campaign: 'partners', status: 'withdrawn' }).expect(200);

    expect(recordsOf(byStatus.text).map((record) => record.code)).toEqual([redeemed.code]);
    expect(recordsOf(byCampaign.text).map((record) => record.code)).toEqual([shared.code]);
    expect(byCampaign.headers['content-disposition']).toContain('invite-codes-partners-');
    expect(recordsOf(both.text)).toEqual([]);
    await exportCsv(source.operator, { status: 'spent' }).expect(400);
  });
});

describe('importing into a fresh deployment', () => {
  it('carries every code over: the unredeemed ones redeem, the spent ones are refused, the counts match the dry run', async () => {
    const { source, live, redeemed, withdrawn, shared } = await usedDeployment();
    const file = (await exportCsv(source.operator).expect(200)).text;
    const target = await deploy(NEW_LANDING);

    const dryRun = (await importCsv(target.operator, file).expect(200)).body;

    expect(dryRun).toMatchObject({
      applied: false,
      ok: true,
      totalRows: 5,
      createCount: 5,
      toCreate: { active: 3, redeemed: 1, expired: 0, withdrawn: 1 },
      campaigns: 2,
      redemptionsLinked: 0,
      redemptionsUnlinked: 2,
      duplicateCount: 0,
      errorCount: 0,
    });
    expect(await codeCount(target.harness)).toBe(0);

    const applied = (await importCsv(target.operator, file, { apply: 'true', expect: dryRun.sha256 }).expect(200)).body;

    expect(applied).toEqual({ ...dryRun, applied: true });
    expect(await codeCount(target.harness)).toBe(5);

    // An unredeemed code is worth here what it was worth there.
    const invited = await signUp(target.harness, 'newcomer@example.com', live.code);
    expect((await expectData(invited, GRANT)).inviteGrant).toEqual({
      campaign: 'launch-2026-10',
      grantMicros: GRANT_MICROS,
    });
    // A code somebody already used, and one an operator withdrew, grant nothing.
    for (const [email, spent] of [
      ['again@example.com', redeemed.code],
      ['late@example.com', withdrawn.code],
    ]) {
      const refused = await signUp(target.harness, email, spent);
      expect((await expectData(refused, GRANT)).inviteGrant, email).toBeNull();
    }
    // A shared code keeps the seats it had left: two of three, and no more.
    for (const email of ['second@example.com', 'third@example.com']) {
      const seated = await signUp(target.harness, email, shared.code);
      expect((await expectData(seated, GRANT)).inviteGrant, email).not.toBeNull();
    }
    const fourth = await signUp(target.harness, 'fourth@example.com', shared.code);
    expect((await expectData(fourth, GRANT)).inviteGrant).toBeNull();
  });

  it('is lossless: the file exported back out differs only in the links, which are this deployment’s own', async () => {
    const { source, live } = await usedDeployment();
    const file = (await exportCsv(source.operator).expect(200)).text;
    const target = await deploy(NEW_LANDING);
    const dryRun = (await importCsv(target.operator, file).expect(200)).body;
    await importCsv(target.operator, file, { apply: 'true', expect: dryRun.sha256 }).expect(200);

    const back = recordsOf((await exportCsv(target.operator).expect(200)).text);

    const withoutUrl = (records: ReturnType<typeof recordsOf>) =>
      records.map(({ url: _url, ...rest }) => rest).sort((left, right) => left.code.localeCompare(right.code));
    expect(withoutUrl(back)).toEqual(withoutUrl(recordsOf(file)));
    for (const record of back) {
      const url = new URL(record.url);
      expect(url.origin).toBe(NEW_LANDING);
      expect(url.searchParams.get('invite')).toBe(record.code);
      expect(url.searchParams.get('utm_campaign')).toBe(record.campaign);
    }
    expect(back.find((record) => record.code === live.code)?.url).not.toBe(live.url);
  });

  it('shows who redeemed a carried code, and links them once that address has an account here', async () => {
    const { source, redeemed } = await usedDeployment();
    const file = (await exportCsv(source.operator).expect(200)).text;
    const target = await deploy(NEW_LANDING);
    const dryRun = (await importCsv(target.operator, file).expect(200)).body;
    await importCsv(target.operator, file, { apply: 'true', expect: dryRun.sha256 }).expect(200);

    const listed = async () => {
      const page = await expectData(target.operator, CODES, { status: 'REDEEMED' });
      return page.adminInviteCodes.nodes.find((node: { code: string }) => node.code === redeemed.code);
    };
    expect(await listed()).toMatchObject({
      status: 'REDEEMED',
      redemptionCount: 1,
      note: 'First mailing',
      issuedByEmail: null,
      redeemers: [{ userId: null, email: 'redeemer@example.com', carried: true }],
    });

    const returned = await signUp(target.harness, 'redeemer@example.com');
    const me = await expectData(returned, '{ me { id } }');

    expect((await listed()).redeemers).toEqual([
      { userId: me.me.id, email: 'redeemer@example.com', carried: true, redeemedAt: expect.any(String) },
    ]);
    // Linked for the operator's benefit only: no credit was written for it here.
    expect((await expectData(returned, GRANT)).inviteGrant).toBeNull();
  });

  it('skips and reports codes that are already here, and never overwrites one', async () => {
    const { source, live } = await usedDeployment();
    const file = (await exportCsv(source.operator).expect(200)).text;

    // The same deployment already holds every code in its own export.
    const again = (await importCsv(source.operator, file).expect(200)).body;
    expect(again).toMatchObject({ ok: true, createCount: 0, duplicateCount: 5, redemptionsUnlinked: 0 });
    expect(again.duplicates).toHaveLength(5);
    expect(again.duplicates[0]).toEqual({
      row: 2,
      code: expect.stringMatching(/^[A-Z2-9]{4}-••••-••••$/),
      reason: 'already_present',
    });

    // Edited to say the live code was withdrawn: still a duplicate, still live.
    const edited = recordsOf(file)
      .filter((record) => record.code === live.code)
      .map((record) => ({ ...record, status: 'withdrawn', withdrawnAt: '2026-01-01T00:00:00.000Z' }));
    const tampered = `${INVITE_CODES_CSV_HEADER.join(',')}\r\n${edited
      .map((record) => INVITE_CODES_CSV_HEADER.map((name) => record[name]).join(','))
      .join('\r\n')}\r\n`;
    const dryRun = (await importCsv(source.operator, tampered).expect(200)).body;
    const applied = (await importCsv(source.operator, tampered, { apply: 'true', expect: dryRun.sha256 }).expect(200))
      .body;

    expect(applied).toMatchObject({ applied: true, createCount: 0, duplicateCount: 1 });
    expect(await codeCount(source.harness)).toBe(5);
    const invited = await signUp(source.harness, 'still-live@example.com', live.code);
    expect((await expectData(invited, GRANT)).inviteGrant).not.toBeNull();
  });
});

describe('refusing a file that is not right', () => {
  it('reports a malformed row by its number and writes none of the good ones', async () => {
    const { source } = await usedDeployment();
    const file = (await exportCsv(source.operator).expect(200)).text;
    const target = await deploy(NEW_LANDING);
    const broken = `${file}ABCD-EFGH-JKM0,,launch-2026-10,25,active,,,2026-10-01T00:00:00.000Z,,,1,\r\nnot,a,row\r\n`;

    const dryRun = (await importCsv(target.operator, broken).expect(200)).body;

    expect(dryRun).toMatchObject({ applied: false, ok: false, totalRows: 7, createCount: 5, errorCount: 2 });
    expect(dryRun.errors).toEqual([
      { row: 7, message: expect.stringContaining('“code”') },
      { row: 8, message: expect.stringContaining('3 column(s)') },
    ]);

    const applied = (await importCsv(target.operator, broken, { apply: 'true', expect: dryRun.sha256 }).expect(200))
      .body;

    expect(applied).toMatchObject({ applied: false, ok: false });
    expect(await codeCount(target.harness)).toBe(0);
    expect(await dataSourceOf(target.harness).getRepository(InviteCarriedRedemption).count()).toBe(0);
  });

  it('refuses a file that is not this export, and a body that is not CSV', async () => {
    const target = await deploy(NEW_LANDING);

    const alien = await importCsv(target.operator, 'email,name\r\na@example.com,A\r\n').expect(400);
    expect(alien.body.message).toContain('not an invitation codes export');
    const minted = await importCsv(target.operator, 'code,url\r\nABCD-EFGH-JKMN,https://x\r\n').expect(400);
    expect(minted.body.message).toContain('not an invitation codes export');
    const json = await request(target.harness.app.getHttpServer())
      .post(IMPORT)
      .set('Cookie', target.operator.cookies)
      .send({ csv: 'code' })
      .expect(400);
    expect(json.body.message).toContain('Content-Type text/csv');
    expect(await codeCount(target.harness)).toBe(0);
  });

  it('applies only the file the dry run looked at', async () => {
    const { source } = await usedDeployment();
    const file = (await exportCsv(source.operator).expect(200)).text;
    const target = await deploy(NEW_LANDING);
    const dryRun = (await importCsv(target.operator, file).expect(200)).body;
    const other = (await exportCsv(source.operator, { campaign: 'partners' }).expect(200)).text;

    await importCsv(target.operator, file, { apply: 'true' }).expect(400);
    const swapped = await importCsv(target.operator, other, { apply: 'true', expect: dryRun.sha256 }).expect(400);

    expect(swapped.body.message).toContain('not the file the dry run looked at');
    expect(await codeCount(target.harness)).toBe(0);
  });
});

describe('who may do either', () => {
  it('refuses a signed-in member and an anonymous caller, and writes nothing for them', async () => {
    const { source } = await usedDeployment();
    const file = (await exportCsv(source.operator).expect(200)).text;
    const target = await deploy(NEW_LANDING);
    const member = await signUp(target.harness, 'member@example.com');

    const exported = await exportCsv(member).expect(403);
    expect(exported.text).not.toContain('launch-2026-10');
    await importCsv(member, file).expect(403);
    await importCsv(member, file, { apply: 'true', expect: 'x' }).expect(403);
    await exportCsv(anonymous(target.harness)).expect(401);
    await importCsv(anonymous(target.harness), file).expect(401);

    expect(await codeCount(target.harness)).toBe(0);
  });
});

describe('the audit trail', () => {
  it('names the operator and the counts for an export, a dry run, an import and a refusal — and never writes a code to the log', async () => {
    const { source } = await usedDeployment();
    const lines: string[] = [];
    const capture = (message: unknown): void => {
      lines.push(String(message));
    };
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation(capture as never);
    }

    const file = (await exportCsv(source.operator).expect(200)).text;
    await exportCsv(source.operator, { campaign: 'partners', status: 'active' }).expect(200);
    const target = await deploy(NEW_LANDING);
    const dryRun = (await importCsv(target.operator, file).expect(200)).body;
    await importCsv(target.operator, file, { apply: 'true', expect: dryRun.sha256 }).expect(200);
    // Again: every row is now a duplicate. Then a malformed row, then an alien file.
    await importCsv(target.operator, file).expect(200);
    await importCsv(target.operator, `${file}ABCD-EFGH-JKM0,,x,1,active,,,nope,,,1,\r\n`).expect(200);
    await importCsv(target.operator, `code,url\r\n${recordsOf(file)[0].code},https://x\r\n`).expect(400);

    const logged = lines.join('\n');
    expect(logged).toContain(`Invitation codes exported by ${OPERATOR} — 5 code(s), every campaign, any status.`);
    expect(logged).toContain(`exported by ${OPERATOR} — 1 code(s), campaign “partners”, active status.`);
    expect(logged).toContain(`import dry run by ${OPERATOR} — clean, nothing written; sha256 ${dryRun.sha256}`);
    expect(logged).toContain(
      `Invitation codes import by ${OPERATOR} — applied; sha256 ${dryRun.sha256}: 5 row(s), +5 code(s)`,
    );
    expect(logged).toContain(
      '(3 unredeemed, 1 redeemed, 0 expired, 1 withdrawn) across 2 campaign(s), 0 duplicate(s) skipped',
    );
    expect(logged).toContain('+0 code(s)');
    expect(logged).toContain('5 duplicate(s) skipped');
    expect(logged).toContain('refused (1 malformed row(s)), nothing written');
    expect(logged).toContain(`import by ${OPERATOR} refused — This is not an invitation codes export`);
    for (const { code, redeemedByEmail } of recordsOf(file)) {
      expect(logged).not.toContain(code);
      expect(logged).not.toContain(normaliseInviteCode(code));
      if (redeemedByEmail) {
        expect(logged).not.toContain(redeemedByEmail);
      }
    }
    expect(logged).not.toContain('JKM0');
  });
});
