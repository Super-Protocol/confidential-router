import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InviteCode } from '../src/app/db/entities/invite-code.entity.js';
import { normaliseInviteCode } from '../src/app/invites/index.js';
import { createHarness, type Harness } from './app-harness.js';
import { anonymous, type ConsoleSession, dataSourceOf, expectData, graphql } from './console.js';

/**
 * The admin console's Invitations section, over the real schema (SUP-268): an
 * operator issues codes, somebody signs up with one, and the redemption shows up
 * in the code list, the account list and the statistics — with every field
 * refused to anyone who is not in `auth.adminEmails`.
 *
 * The operator is the account `/auth/bootstrap` creates, which is how a
 * production deployment gets its first administrator — and which is also what
 * the account list has to recognise as the BOOTSTRAP origin.
 */

const BOOTSTRAP_TOKEN = 'bootstrap-token-'.padEnd(40, 'x');
const OPERATOR = 'admin@confidential-router.local';
const PASSWORD = 'correct-horse-battery';
const LANDING = 'https://router.superprotocol.com';
const GRANT_MICROS = '25000000';

const ISSUE = `
  mutation Issue($input: IssueInviteCodesInput!) {
    issueInviteCodes(input: $input) { campaign grantMicros expiresAt codes { id code url } }
  }
`;
const CODES = `
  query Codes($campaign: String, $status: InviteCodeStatus, $offset: Int, $limit: Int) {
    adminInviteCodes(campaign: $campaign, status: $status, offset: $offset, limit: $limit) {
      totalCount
      nodes {
        id code url campaign grantMicros maxRedemptions redemptionCount status
        createdAt expiresAt withdrawnAt note issuedByEmail
        redeemers { userId email redeemedAt }
      }
    }
  }
`;
const SIGN_UPS = `
  query SignUps($origin: SignUpOrigin) {
    adminSignUps(origin: $origin) {
      totalCount
      nodes { userId email origin inviteCodeId inviteCode campaign redeemedAt }
    }
  }
`;
const STATISTICS = `
  query Statistics($days: Int) {
    inviteStatistics(days: $days) {
      totals { issued redeemed withdrawn redemptionRate grantedMicros signUps }
      daily { date codesIssued codesRedeemed signUpsInvited signUpsBootstrap signUpsOpen }
      campaigns { campaign issued redeemed redemptionRate grantedMicros }
    }
  }
`;
const WITHDRAW = `
  mutation Withdraw($id: ID!) {
    withdrawInviteCode(id: $id) { target matched withdrawn alreadyWithdrawn spent }
  }
`;

let harness: Harness;
let operator: ConsoleSession;

beforeEach(async () => {
  harness = await createHarness({
    env: {
      CR_API_AUTH__PASSWORD__ENABLED: 'true',
      CR_API_AUTH__BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN,
      CR_API_AUTH__ADMIN_EMAILS: OPERATOR,
      CR_API_INVITES__LANDING_BASE_URL: LANDING,
    },
  });
  const claimed = await request(server()).post('/auth/bootstrap').send({ token: BOOTSTRAP_TOKEN }).expect(200);
  operator = await sessionOf(claimed);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await harness?.close();
});

function server() {
  return harness.app.getHttpServer();
}

async function sessionOf(response: request.Response): Promise<ConsoleSession> {
  const raw = response.headers['set-cookie'];
  const cookies = (Array.isArray(raw) ? raw : [raw].filter(Boolean)) as string[];
  const session = { harness, cookies, email: '', workspaceId: '' };
  const me = await graphql(session, '{ me { email workspaces { id } } }');
  return { ...session, email: me.data.me.email, workspaceId: me.data.me.workspaces[0].id };
}

function signUp(email: string, inviteCode?: string) {
  return request(server())
    .post('/auth/sign-up/email')
    .send({ email, password: PASSWORD, name: email.split('@')[0], ...(inviteCode ? { inviteCode } : {}) })
    .expect(200);
}

async function issue(count: number, campaign = 'launch-2026-10'): Promise<{ id: string; code: string; url: string }[]> {
  const data = await expectData(operator, ISSUE, { input: { count, grantMicros: GRANT_MICROS, campaign } });
  return data.issueInviteCodes.codes;
}

describe('issuing from the console', () => {
  it('issues a single code and a batch of fifty, on the landing page’s links, recorded against the operator', async () => {
    const single = await expectData(operator, ISSUE, {
      input: { count: 1, grantMicros: GRANT_MICROS, campaign: 'vip', note: 'For the keynote' },
    });
    const batch = await issue(50);

    expect(single.issueInviteCodes).toMatchObject({ campaign: 'vip', grantMicros: GRANT_MICROS, expiresAt: null });
    expect(single.issueInviteCodes.codes).toHaveLength(1);
    expect(batch).toHaveLength(50);
    expect(new Set(batch.map((code) => code.code)).size).toBe(50);
    for (const invite of batch) {
      const url = new URL(invite.url);
      expect(url.origin).toBe(LANDING);
      expect(url.searchParams.get('invite')).toBe(invite.code);
    }

    const rows = await dataSourceOf(harness).getRepository(InviteCode).find();
    expect(rows).toHaveLength(51);
    const listed = await expectData(operator, CODES, { campaign: 'vip' });
    expect(listed.adminInviteCodes.nodes[0]).toMatchObject({
      code: single.issueInviteCodes.codes[0].code,
      note: 'For the keynote',
      issuedByEmail: OPERATOR,
      status: 'ACTIVE',
    });
  });

  it('takes an expiry, and refuses one in the past', async () => {
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const issued = await expectData(operator, ISSUE, {
      input: { count: 1, grantMicros: GRANT_MICROS, campaign: 'expiring', expiresAt },
    });
    expect(issued.issueInviteCodes.expiresAt).toBe(expiresAt);

    const refused = await graphql(operator, ISSUE, {
      input: { count: 1, grantMicros: GRANT_MICROS, campaign: 'expired', expiresAt: '2020-01-01T00:00:00.000Z' },
    });
    expect(refused.errors?.[0].message).toContain('in the past');
  });

  it('refuses a credit above the console’s ceiling, a batch above its cap, and a tag that would split a campaign', async () => {
    for (const input of [
      { count: 1, grantMicros: '10000000001', campaign: 'fat-finger' },
      { count: 1001, grantMicros: GRANT_MICROS, campaign: 'too-many' },
      { count: 1, grantMicros: GRANT_MICROS, campaign: 'Launch 2026' },
      { count: 1, grantMicros: '0', campaign: 'free' },
    ]) {
      const refused = await graphql(operator, ISSUE, { input });
      expect(refused.errors, JSON.stringify(input)).toBeDefined();
    }
    expect(await dataSourceOf(harness).getRepository(InviteCode).count()).toBe(0);
  });

  it('never writes a code to the log — issuing or withdrawing', async () => {
    const lines: string[] = [];
    const capture = (message: unknown): void => {
      lines.push(String(message));
    };
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation(capture as never);
    }

    const [first, second, third] = await issue(3);
    await expectData(operator, WITHDRAW, { id: first.id });
    await signUp('redeemer@example.com', second.code);
    // The CLI's counterpart takes the code itself; its audit line masks it.
    await expectData(
      operator,
      'mutation Disable($input: DisableInviteCodesInput!) { disableInviteCodes(input: $input) { withdrawn } }',
      { input: { code: third.code } },
    );

    const logged = lines.join('\n');
    expect(logged).toContain(`issued by ${OPERATOR}`);
    expect(logged).toContain('withdrawn by');
    expect(logged).toContain(`${third.code.slice(0, 4)}-••••-••••`);
    for (const code of [first.code, second.code, third.code]) {
      expect(logged).not.toContain(code);
      expect(logged).not.toContain(normaliseInviteCode(code));
    }
  });
});

describe('who came from which code', () => {
  it('shows a redemption in the code list, the account list and the statistics', async () => {
    const [redeemed, untouched] = await issue(2);
    const redeemer = await sessionOf(await signUp('redeemer@example.com', redeemed.code));
    await signUp('open@example.com');

    const codes = await expectData(operator, CODES, {});
    const byId = new Map(codes.adminInviteCodes.nodes.map((node: { id: string }) => [node.id, node]));
    expect(byId.get(redeemed.id)).toMatchObject({
      status: 'REDEEMED',
      redemptionCount: 1,
      redeemers: [{ email: 'redeemer@example.com' }],
    });
    expect(byId.get(untouched.id)).toMatchObject({ status: 'ACTIVE', redeemers: [] });

    const signUps = await expectData(operator, SIGN_UPS, {});
    const byEmail = new Map(signUps.adminSignUps.nodes.map((node: { email: string }) => [node.email, node]));
    expect(signUps.adminSignUps.totalCount).toBe(3);
    expect(byEmail.get('redeemer@example.com')).toMatchObject({
      userId: expect.any(String),
      origin: 'INVITE',
      inviteCodeId: redeemed.id,
      inviteCode: redeemed.code,
      campaign: 'launch-2026-10',
    });
    expect(byEmail.get(OPERATOR)).toMatchObject({ origin: 'BOOTSTRAP', inviteCode: null });
    expect(byEmail.get('open@example.com')).toMatchObject({ origin: 'OPEN', inviteCode: null });
    expect(redeemer.email).toBe('redeemer@example.com');

    const invited = await expectData(operator, SIGN_UPS, { origin: 'INVITE' });
    expect(invited.adminSignUps.nodes.map((node: { email: string }) => node.email)).toEqual(['redeemer@example.com']);

    const stats = await expectData(operator, STATISTICS, { days: 7 });
    expect(stats.inviteStatistics.totals).toEqual({
      issued: 2,
      redeemed: 1,
      withdrawn: 0,
      redemptionRate: 0.5,
      grantedMicros: GRANT_MICROS,
      signUps: 3,
    });
    expect(stats.inviteStatistics.daily).toHaveLength(7);
    expect(stats.inviteStatistics.daily[6]).toMatchObject({
      date: new Date().toISOString().slice(0, 10),
      codesIssued: 2,
      codesRedeemed: 1,
      signUpsInvited: 1,
      signUpsBootstrap: 1,
      signUpsOpen: 1,
    });
    expect(stats.inviteStatistics.campaigns).toEqual([
      { campaign: 'launch-2026-10', issued: 2, redeemed: 1, redemptionRate: 0.5, grantedMicros: GRANT_MICROS },
    ]);
  });
});

describe('withdrawing from the console', () => {
  it('withdraws an unredeemed code by id, and the next sign-up with it gets no credit', async () => {
    const [invite] = await issue(1);

    const withdrawal = await expectData(operator, WITHDRAW, { id: invite.id });
    expect(withdrawal.withdrawInviteCode).toEqual({
      target: `invitation ${invite.id}`,
      matched: 1,
      withdrawn: 1,
      alreadyWithdrawn: 0,
      spent: 0,
    });

    const listed = await expectData(operator, CODES, { status: 'WITHDRAWN' });
    expect(listed.adminInviteCodes.nodes.map((node: { id: string }) => node.id)).toEqual([invite.id]);
    expect(listed.adminInviteCodes.nodes[0].withdrawnAt).not.toBeNull();

    const late = await sessionOf(await signUp('late@example.com', invite.code));
    expect((await expectData(late, '{ inviteGrant { campaign } }')).inviteGrant).toBeNull();
  });

  it('leaves a redeemed code alone', async () => {
    const [invite] = await issue(1);
    await signUp('redeemer@example.com', invite.code);

    const withdrawal = await expectData(operator, WITHDRAW, { id: invite.id });

    expect(withdrawal.withdrawInviteCode).toMatchObject({ matched: 1, withdrawn: 0, spent: 1 });
  });
});

describe('who may see any of it', () => {
  const OPERATIONS: [string, string, Record<string, unknown>][] = [
    ['adminInviteCodes', CODES, {}],
    ['adminSignUps', SIGN_UPS, {}],
    ['inviteStatistics', STATISTICS, {}],
    ['issueInviteCodes', ISSUE, { input: { count: 1, grantMicros: GRANT_MICROS, campaign: 'x' } }],
    ['withdrawInviteCode', WITHDRAW, { id: 'any' }],
  ];

  it('refuses a signed-in member who is not an operator, and mints nothing for them', async () => {
    const member = await sessionOf(await signUp('member@example.com'));

    for (const [field, query, variables] of OPERATIONS) {
      const refused = await graphql(member, query, variables);
      expect(refused.errors?.[0].extensions.code, field).toBe('FORBIDDEN');
      expect(refused.data?.[field] ?? null, field).toBeNull();
    }
    expect(await dataSourceOf(harness).getRepository(InviteCode).count()).toBe(0);
  });

  it('refuses an anonymous caller', async () => {
    for (const [field, query, variables] of OPERATIONS) {
      const refused = await graphql(anonymous(harness), query, variables);
      expect(refused.errors?.[0].extensions.code, field).toBe('UNAUTHENTICATED');
    }
  });
});
