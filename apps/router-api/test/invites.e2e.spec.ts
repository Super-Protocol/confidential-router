import request from 'supertest';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InviteCode } from '../src/app/db/entities/invite-code.entity.js';
import { formatInviteCode, generateInvites, mintInviteCode } from '../src/app/invites/index.js';
import { createHarness, type Harness, pathOf, signUpWithCode } from './app-harness.js';
import { anonymous, type ConsoleSession, dataSourceOf, expectData, graphql } from './console.js';

/**
 * Invitation codes end to end: the public lookup the landing page calls, the
 * redemption that happens inside a real sign-up, and what the console can read
 * afterwards.
 *
 * Every case boots the real application — the same guards, the same Better Auth
 * wiring, the same migrations — because the two properties that matter most are
 * both properties of the wiring: that the grant happens *inside* account
 * creation, and that a code which cannot be redeemed does not take the
 * registration down with it.
 */

const GRANT_MICROS = 100_000_000;
const CAMPAIGN = 'launch-2026-10-devs';

const INVITE_GRANT = '{ inviteGrant { grantMicros campaign creditTransactionId redeemedAt } }';
const GRANT_STATUS = `
  query Status($code: String) {
    inviteGrantStatus(code: $code) { reason grant { grantMicros campaign } }
  }
`;
const LEDGER = `
  query Ledger($workspaceId: ID!) {
    creditTransactions(workspaceId: $workspaceId, first: 10) {
      edges { node { kind amountMicros reference description } }
    }
  }
`;
const CAMPAIGNS = `
  query Campaigns($campaign: String) {
    inviteCampaigns(campaign: $campaign) { campaign issued redeemed redemptionRate activated grantedMicros }
  }
`;

let harness: Harness;

/** A deployment a test can create an account on in one call: `signUp` asks for a code and trades it in. */
async function inviteHarness(env: Record<string, string> = {}): Promise<Harness> {
  harness = await createHarness({
    env: {
      CR_API_INVITES__LANDING_BASE_URL: 'https://router.superprotocol.com',
      ...env,
    },
  });
  return harness;
}

afterEach(async () => {
  await harness?.close();
  harness = undefined as unknown as Harness;
});

/** Mints one campaign's codes through the same generator the CLI uses. */
async function issue(
  dataSource: DataSource,
  overrides: Partial<Parameters<typeof generateInvites>[1]> = {},
): Promise<{ code: string; url: string }[]> {
  return generateInvites(dataSource, {
    count: 1,
    grantMicros: GRANT_MICROS,
    campaign: CAMPAIGN,
    maxRedemptions: 1,
    expiresAt: null,
    note: null,
    landingBaseUrl: 'https://router.superprotocol.com',
    ...overrides,
  });
}

function server() {
  return harness.app.getHttpServer();
}

function lookup(code: string) {
  return request(server()).get(`/v1/invites/${encodeURIComponent(code)}`);
}

function signUp(body: Record<string, unknown>, query = '') {
  return signUpWithCode(harness, body, query);
}

function sessionCookiesOf(response: request.Response): string[] {
  const cookies = response.headers['set-cookie'];
  return (Array.isArray(cookies) ? cookies : [cookies].filter(Boolean)) as string[];
}

async function consoleSession(cookies: string[]): Promise<ConsoleSession> {
  const session = { harness, cookies, email: '', workspaceId: '' };
  const me = await graphql(session, '{ me { workspaces { id } } }');
  return { ...session, workspaceId: me.data.me.workspaces[0].id };
}

describe('GET /v1/invites/:code', () => {
  beforeEach(async () => {
    await inviteHarness();
  });

  it('tells an anonymous caller what a usable code grants', async () => {
    const [invite] = await issue(dataSourceOf(harness));

    const response = await lookup(invite.code).expect(200);

    expect(response.body).toEqual({ valid: true, grantMicros: String(GRANT_MICROS), campaign: CAMPAIGN });
  });

  it('accepts the code in any case and with the separators stripped', async () => {
    const [invite] = await issue(dataSourceOf(harness));

    await lookup(invite.code.toLowerCase())
      .expect(200)
      .expect({ ...validBody() });
    await lookup(invite.code.replace(/-/g, ''))
      .expect(200)
      .expect({ ...validBody() });
  });

  it('gives one answer for every code it cannot redeem, whatever the real reason', async () => {
    const dataSource = dataSourceOf(harness);
    const [expired] = await issue(dataSource, { expiresAt: new Date('2020-01-01T00:00:00Z') });
    const [spent] = await issue(dataSource, { campaign: 'other' });
    await dataSource.getRepository(InviteCode).update({ campaign: 'other' }, { redemptionCount: 1 });

    // A response that told "expired" apart from "never existed" would confirm a
    // guessed code is real, which is most of the work of stealing a grant.
    for (const code of [expired.code, spent.code, formatInviteCode(mintInviteCode()), 'not-a-code-at-all']) {
      const answer = await lookup(code).expect(200);
      expect(answer.body).toEqual({ valid: false, reason: 'unavailable' });
    }
  });

  it('is never cached, because a spent grant must stop reading as available', async () => {
    const [invite] = await issue(dataSourceOf(harness));

    expect((await lookup(invite.code)).headers['cache-control']).toBe('no-store');
  });

  it('is reached before the /v1 fallback, which claims every other path under /v1', async () => {
    const [invite] = await issue(dataSourceOf(harness));

    await lookup(invite.code).expect(200);
    // The fallback is still in place for everything else, in the OpenAI envelope.
    const unknown = await request(server()).get('/v1/moderations').expect(404);
    expect(unknown.body.error.code).toBe('not_found');
  });
});

describe('the lookup rate limit', () => {
  it('refuses a caller that goes past its minute budget, and says when to retry', async () => {
    await inviteHarness({ CR_API_INVITES__LOOKUPS_PER_MINUTE: '3' });
    const [invite] = await issue(dataSourceOf(harness));

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await lookup(invite.code).expect(200);
    }
    const refused = await lookup(invite.code).expect(429);

    expect(refused.headers['retry-after']).toBeDefined();
  });
});

describe('signing up with an invitation', () => {
  beforeEach(async () => {
    await inviteHarness();
  });

  it('creates the account and credits it, in the sign-up itself', async () => {
    const [invite] = await issue(dataSourceOf(harness));

    const created = await signUp({
      email: 'invited@example.com',
      name: 'Invited',
      inviteCode: invite.code,
    }).expect(200);

    const session = await consoleSession(sessionCookiesOf(created));
    // The credit is there on the first page load, not after some later call.
    const balance = await expectData(
      session,
      `{ creditBalance(workspaceId: "${session.workspaceId}") { balanceMicros spendable } }`,
    );
    expect(balance.creditBalance).toEqual({ balanceMicros: String(GRANT_MICROS), spendable: true });

    const grant = await expectData(session, INVITE_GRANT);
    expect(grant.inviteGrant).toMatchObject({ grantMicros: String(GRANT_MICROS), campaign: CAMPAIGN });
  });

  it('shows the grant on the Credits screen as an ordinary ledger entry naming its campaign', async () => {
    const [invite] = await issue(dataSourceOf(harness));
    const created = await signUp({
      email: 'ledger@example.com',
      name: 'Ledger',
      inviteCode: invite.code,
    }).expect(200);
    const session = await consoleSession(sessionCookiesOf(created));

    const ledger = await expectData(session, LEDGER, { workspaceId: session.workspaceId });

    expect(ledger.creditTransactions.edges).toHaveLength(1);
    expect(ledger.creditTransactions.edges[0].node).toMatchObject({
      kind: 'GRANT',
      amountMicros: String(GRANT_MICROS),
      reference: CAMPAIGN,
    });
  });

  it('takes the code from the query string too, which is how the landing page passes it on', async () => {
    const [invite] = await issue(dataSourceOf(harness));

    const created = await signUp(
      { email: 'query@example.com', name: 'Query' },
      `?invite=${encodeURIComponent(invite.code)}`,
    ).expect(200);

    const grant = await expectData(await consoleSession(sessionCookiesOf(created)), INVITE_GRANT);
    expect(grant.inviteGrant).toMatchObject({ campaign: CAMPAIGN });
  });

  it('spends the code: the lookup stops offering it', async () => {
    const [invite] = await issue(dataSourceOf(harness));
    await lookup(invite.code).expect(200).expect(validBody());

    await signUp({ email: 'first@example.com', name: 'First', inviteCode: invite.code }).expect(200);

    await lookup(invite.code).expect(200).expect({ valid: false, reason: 'unavailable' });
  });
});

describe('the operator sign-up grant (SUP-249)', () => {
  const SIGNUP_GRANT_MICROS = 20_000_000;

  async function balanceAfterSignUp(body: Record<string, unknown>): Promise<{ balance: string; ledger: unknown[] }> {
    const created = await signUp({ name: 'New', ...body }).expect(200);
    const session = await consoleSession(sessionCookiesOf(created));
    const data = await expectData(
      session,
      `{ creditBalance(workspaceId: "${session.workspaceId}") { balanceMicros } }`,
    );
    const ledger = await expectData(session, LEDGER, { workspaceId: session.workspaceId });
    return {
      balance: data.creditBalance.balanceMicros,
      ledger: ledger.creditTransactions.edges.map((edge: { node: unknown }) => edge.node),
    };
  }

  it('credits every new account, visible on its first page load', async () => {
    await inviteHarness({ CR_API_BILLING__SIGNUP_GRANT_MICROS: String(SIGNUP_GRANT_MICROS) });

    const { balance, ledger } = await balanceAfterSignUp({ email: 'organic@example.com' });

    expect(balance).toBe(String(SIGNUP_GRANT_MICROS));
    expect(ledger).toEqual([
      {
        kind: 'GRANT',
        amountMicros: String(SIGNUP_GRANT_MICROS),
        reference: 'signup',
        description: expect.any(String),
      },
    ]);
  });

  it('stacks with an invitation: 20 + 100 = 120', async () => {
    await inviteHarness({ CR_API_BILLING__SIGNUP_GRANT_MICROS: String(SIGNUP_GRANT_MICROS) });
    const [invite] = await issue(dataSourceOf(harness));

    const { balance, ledger } = await balanceAfterSignUp({ email: 'both@example.com', inviteCode: invite.code });

    expect(balance).toBe(String(SIGNUP_GRANT_MICROS + GRANT_MICROS));
    expect(ledger).toHaveLength(2);
  });

  it('grants nothing at 0, the schema default', async () => {
    await inviteHarness();

    const { balance, ledger } = await balanceAfterSignUp({ email: 'unfunded@example.com' });

    expect(balance).toBe('0');
    expect(ledger).toEqual([]);
  });
});

describe('signing up with a code that cannot be redeemed', () => {
  beforeEach(async () => {
    await inviteHarness();
  });

  /** The registration succeeded and the account has no credit. */
  async function expectAccountWithoutCredit(created: request.Response): Promise<void> {
    expect(created.status).toBe(200);
    const session = await consoleSession(sessionCookiesOf(created));
    const data = await expectData(
      session,
      `{ inviteGrant { campaign } creditBalance(workspaceId: "${session.workspaceId}") { balanceMicros } }`,
    );
    expect(data.inviteGrant).toBeNull();
    expect(data.creditBalance.balanceMicros).toBe('0');
  }

  it('still creates the account when the code was already used', async () => {
    const [invite] = await issue(dataSourceOf(harness));
    await signUp({ email: 'first@example.com', name: 'First', inviteCode: invite.code }).expect(200);

    await expectAccountWithoutCredit(
      await signUp({ email: 'second@example.com', name: 'Second', inviteCode: invite.code }),
    );
  });

  it('still creates the account for outright garbage', async () => {
    await expectAccountWithoutCredit(
      await signUp({ email: 'garbage@example.com', name: 'Garbage', inviteCode: 'ZZZZ-ZZZZ-ZZZZ' }),
    );
  });

  it('still creates the account when the code is not even code-shaped', async () => {
    await expectAccountWithoutCredit(
      await signUp({
        email: 'nonsense@example.com',
        name: 'Nonsense',
        inviteCode: '../../etc/passwd',
      }),
    );
  });

  it('still creates the account when the code expired', async () => {
    const [invite] = await issue(dataSourceOf(harness), { expiresAt: new Date('2020-01-01T00:00:00Z') });

    await expectAccountWithoutCredit(
      await signUp({ email: 'expired@example.com', name: 'Expired', inviteCode: invite.code }),
    );
  });

  it('cannot be topped up by signing in again with another code', async () => {
    const dataSource = dataSourceOf(harness);
    const [first] = await issue(dataSource);
    const [second] = await issue(dataSource, { campaign: 'launch-2026-11' });
    const created = await signUp({
      email: 'twice@example.com',
      name: 'Twice',
      inviteCode: first.code,
    }).expect(200);
    const session = await consoleSession(sessionCookiesOf(created));

    // Redemption lives in account creation, so the second sign-in has nothing to
    // redeem with — which is the property that makes the grant unreplayable.
    await signUp({ email: 'twice@example.com' }, `?invite=${encodeURIComponent(second.code)}`).expect(200);

    const data = await expectData(
      session,
      `{ creditBalance(workspaceId: "${session.workspaceId}") { balanceMicros } }`,
    );
    expect(data.creditBalance.balanceMicros).toBe(String(GRANT_MICROS));
    // And the untouched code is still there for whoever it was mailed to.
    expect((await lookup(second.code)).body).toEqual({
      valid: true,
      grantMicros: String(GRANT_MICROS),
      campaign: 'launch-2026-11',
    });
  });
});

describe('a magic-link sign-up', () => {
  it('carries the code in the callbackURL, which is the only thing it keeps', async () => {
    await inviteHarness();
    const [invite] = await issue(dataSourceOf(harness));

    await request(server())
      .post('/auth/sign-in/magic-link')
      .send({ email: 'magic@example.com', callbackURL: `/?invite=${encodeURIComponent(invite.code)}` });
    const verified = await request(server()).get(pathOf(harness.mailer.last.url));

    const session = await consoleSession(sessionCookiesOf(verified));
    const grant = await expectData(session, INVITE_GRANT);
    expect(grant.inviteGrant).toMatchObject({ grantMicros: String(GRANT_MICROS), campaign: CAMPAIGN });
  });
});

describe('the generated CSV', () => {
  it('has URLs whose codes resolve against the real lookup endpoint', async () => {
    await inviteHarness();
    const invites = await issue(dataSourceOf(harness), { count: 5 });

    for (const invite of invites) {
      const code = new URL(invite.url).searchParams.get('invite');
      expect(code).toBe(invite.code);
      await lookup(code as string)
        .expect(200)
        .expect(validBody());
    }
  });
});

describe('the post-sign-up screen', () => {
  beforeEach(async () => {
    await inviteHarness();
  });

  async function accountWith(code: string | undefined, email: string): Promise<ConsoleSession> {
    const created = await signUp({
      email,
      name: 'Arrived',
      ...(code ? { inviteCode: code } : {}),
    }).expect(200);
    return consoleSession(sessionCookiesOf(created));
  }

  it('confirms the credit, with the campaign that paid for it', async () => {
    const [invite] = await issue(dataSourceOf(harness));
    const session = await accountWith(invite.code, 'welcome@example.com');

    const status = await expectData(session, GRANT_STATUS, { code: invite.code });

    expect(status.inviteGrantStatus).toEqual({
      reason: null,
      grant: { grantMicros: String(GRANT_MICROS), campaign: CAMPAIGN },
    });
  });

  /**
   * Each refusal gets its own reason, which the anonymous lookup deliberately
   * withholds. Safe here: the caller holds a session and already holds the code,
   * so "expired" tells them nothing trying it would not have.
   */
  it('says why, one reason per failure mode', async () => {
    const dataSource = dataSourceOf(harness);
    const [expired] = await issue(dataSource, { expiresAt: new Date('2020-01-01T00:00:00Z'), campaign: 'expired-c' });
    const [spent] = await issue(dataSource, { campaign: 'spent-c' });
    const [disabled] = await issue(dataSource, { campaign: 'disabled-c' });
    await dataSource.getRepository(InviteCode).update({ campaign: 'spent-c' }, { redemptionCount: 1 });
    await dataSource.getRepository(InviteCode).update({ campaign: 'disabled-c' }, { disabledAt: new Date() });

    const cases: [string, string][] = [
      [expired.code, 'EXPIRED'],
      [spent.code, 'EXHAUSTED'],
      [disabled.code, 'DISABLED'],
      [formatInviteCode(mintInviteCode()), 'NOT_FOUND'],
      ['../../etc/passwd', 'NOT_FOUND'],
    ];

    let index = 0;
    for (const [code, reason] of cases) {
      const session = await accountWith(code, `refused-${index}@example.com`);
      index += 1;
      const status = await expectData(session, GRANT_STATUS, { code });
      expect(status.inviteGrantStatus, code).toEqual({ reason, grant: null });
    }
  });

  it('says an account that already has a credit cannot have a second one', async () => {
    const dataSource = dataSourceOf(harness);
    const [first] = await issue(dataSource);
    const [second] = await issue(dataSource, { campaign: 'another-campaign' });
    const session = await accountWith(first.code, 'already@example.com');

    const status = await expectData(session, GRANT_STATUS, { code: second.code });

    // Both halves are true, and the screen has to say both: the account has its
    // grant, and the code it just presented bought nothing.
    expect(status.inviteGrantStatus.grant).toMatchObject({ campaign: CAMPAIGN });
    expect(status.inviteGrantStatus.reason).toBe('ALREADY_REDEEMED');
  });

  it('answers a visitor who arrived without a code at all', async () => {
    const session = await accountWith(undefined, 'organic@example.com');

    expect((await expectData(session, GRANT_STATUS, {})).inviteGrantStatus).toEqual({ reason: null, grant: null });
  });

  it('refuses an anonymous caller', async () => {
    const refused = await graphql(anonymous(harness), GRANT_STATUS, { code: 'ZZZZ-ZZZZ-ZZZZ' });

    expect(refused.errors?.[0].extensions.code).toBe('UNAUTHENTICATED');
  });

  it('spends the invitation-lookup budget, so a session is not a second allowance', async () => {
    await harness.close();
    await inviteHarness({ CR_API_INVITES__LOOKUPS_PER_MINUTE: '2' });
    const session = await accountWith(undefined, 'curious@example.com');
    const guess = () => graphql(session, GRANT_STATUS, { code: formatInviteCode(mintInviteCode()) });

    await guess();
    await guess();
    const refused = await guess();

    expect(refused.errors?.[0].message).toContain('Too many invitation lookups');
  });
});

describe('the campaign stats query', () => {
  it('answers an operator, and refuses everyone else', async () => {
    await inviteHarness({ CR_API_AUTH__ADMIN_EMAILS: 'ops@example.com' });
    const dataSource = dataSourceOf(harness);
    const invites = await issue(dataSource, { count: 4 });
    const redeemed = await signUp({
      email: 'redeemer@example.com',
      name: 'Redeemer',
      inviteCode: invites[0].code,
    }).expect(200);

    const operator = await consoleSession(
      sessionCookiesOf(await signUp({ email: 'ops@example.com', name: 'Ops' }).expect(200)),
    );
    const stats = await expectData(operator, CAMPAIGNS, { campaign: CAMPAIGN });
    expect(stats.inviteCampaigns).toEqual([
      {
        campaign: CAMPAIGN,
        issued: 4,
        redeemed: 1,
        redemptionRate: 0.25,
        // Redeemed, but has not sent a request yet.
        activated: 0,
        grantedMicros: String(GRANT_MICROS),
      },
    ]);

    const outsider = await consoleSession(sessionCookiesOf(redeemed));
    const refused = await graphql(outsider, CAMPAIGNS);
    expect(refused.errors?.[0].extensions.code).toBe('FORBIDDEN');
    expect(refused.data?.inviteCampaigns ?? null).toBeNull();
  });

  it('refuses an anonymous caller before it refuses a non-operator', async () => {
    await inviteHarness({ CR_API_AUTH__ADMIN_EMAILS: 'ops@example.com' });

    const refused = await graphql({ harness, cookies: [], email: '', workspaceId: '' }, CAMPAIGNS);

    expect(refused.errors?.[0].extensions.code).toBe('UNAUTHENTICATED');
  });
});

/**
 * The kill switch over the console schema — the path that exists because a
 * published cluster has no shell to run `invites disable` in (SUP-159).
 *
 * End to end rather than in the service spec, because what is being checked is
 * the wiring: that the guard is on the mutation, and that a withdrawal made
 * through it is the same withdrawal a redemption inside a real sign-up honours.
 */
describe('the kill switch', () => {
  const DISABLE = `
    mutation Disable($input: DisableInviteCodesInput!) {
      disableInviteCodes(input: $input) { target matched withdrawn alreadyWithdrawn spent }
    }
  `;
  const RESTORE = `
    mutation Restore($input: RestoreInviteCodesInput!) {
      restoreInviteCodes(input: $input) { target matched restored alreadyUsable }
    }
  `;

  async function operator(): Promise<ConsoleSession> {
    return consoleSession(sessionCookiesOf(await signUp({ email: 'ops@example.com', name: 'Ops' }).expect(200)));
  }

  beforeEach(async () => {
    await inviteHarness({ CR_API_AUTH__ADMIN_EMAILS: 'ops@example.com' });
  });

  it('withdraws a leaked code, and the next sign-up gets an account but no credit', async () => {
    const [invite] = await issue(dataSourceOf(harness));
    const ops = await operator();

    const withdrawal = await expectData(ops, DISABLE, { input: { code: invite.code } });

    expect(withdrawal.disableInviteCodes).toEqual({
      target: invite.code,
      matched: 1,
      withdrawn: 1,
      alreadyWithdrawn: 0,
      spent: 0,
    });
    // The landing page stops promising the credit…
    await lookup(invite.code).expect(200).expect({ valid: false, reason: 'unavailable' });
    // …and the registration still succeeds, with nothing granted and a reason.
    const late = await consoleSession(
      sessionCookiesOf(
        await signUp({
          email: 'too-late@example.com',
          name: 'Late',
          inviteCode: invite.code,
        }).expect(200),
      ),
    );
    expect((await expectData(late, GRANT_STATUS, { code: invite.code })).inviteGrantStatus).toEqual({
      grant: null,
      reason: 'DISABLED',
    });
  });

  it('withdraws a campaign without touching the credit it already granted', async () => {
    const invites = await issue(dataSourceOf(harness), { count: 2 });
    const redeemed = await consoleSession(
      sessionCookiesOf(
        await signUp({
          email: 'early@example.com',
          name: 'Early',
          inviteCode: invites[0].code,
        }).expect(200),
      ),
    );
    const ops = await operator();

    const withdrawal = await expectData(ops, DISABLE, { input: { campaign: CAMPAIGN, unspentOnly: true } });

    expect(withdrawal.disableInviteCodes).toMatchObject({ matched: 2, withdrawn: 1, spent: 1 });
    // The account that got in keeps its $100: the ledger entry and the grant.
    const ledger = await expectData(redeemed, LEDGER, { workspaceId: redeemed.workspaceId });
    expect(ledger.creditTransactions.edges).toEqual([
      {
        node: {
          kind: 'GRANT',
          amountMicros: String(GRANT_MICROS),
          reference: CAMPAIGN,
          description: `Invitation credit · ${CAMPAIGN}`,
        },
      },
    ]);
    expect((await expectData(redeemed, INVITE_GRANT)).inviteGrant).toMatchObject({
      grantMicros: String(GRANT_MICROS),
      campaign: CAMPAIGN,
    });
  });

  it('puts a withdrawn code back, and it grants again', async () => {
    const [invite] = await issue(dataSourceOf(harness));
    const ops = await operator();
    await expectData(ops, DISABLE, { input: { code: invite.code } });

    const restoration = await expectData(ops, RESTORE, { input: { code: invite.code } });

    expect(restoration.restoreInviteCodes).toEqual({
      target: invite.code,
      matched: 1,
      restored: 1,
      alreadyUsable: 0,
    });
    await lookup(invite.code).expect(200).expect(validBody());
    const late = await consoleSession(
      sessionCookiesOf(
        await signUp({
          email: 'second-chance@example.com',
          name: 'Second',
          inviteCode: invite.code,
        }).expect(200),
      ),
    );
    expect((await expectData(late, INVITE_GRANT)).inviteGrant).toMatchObject({ grantMicros: String(GRANT_MICROS) });
  });

  it('refuses a signed-in caller who is not an operator, and leaves the code usable', async () => {
    const [invite] = await issue(dataSourceOf(harness));
    const outsider = await consoleSession(
      sessionCookiesOf(await signUp({ email: 'outsider@example.com', name: 'Outsider' }).expect(200)),
    );

    const refused = await graphql(outsider, DISABLE, { input: { code: invite.code } });

    expect(refused.errors?.[0].extensions.code).toBe('FORBIDDEN');
    await lookup(invite.code).expect(200).expect(validBody());
  });

  it('refuses an anonymous caller', async () => {
    const [invite] = await issue(dataSourceOf(harness));

    const refused = await graphql(anonymous(harness), DISABLE, { input: { code: invite.code } });

    expect(refused.errors?.[0].extensions.code).toBe('UNAUTHENTICATED');
    await lookup(invite.code).expect(200).expect(validBody());
  });

  it('tells an operator who named neither target, or both, what is wrong', async () => {
    const ops = await operator();

    const neither = await graphql(ops, DISABLE, { input: {} });
    const both = await graphql(ops, DISABLE, { input: { code: 'ZZZZ-ZZZZ-ZZZZ', campaign: CAMPAIGN } });

    expect(neither.errors?.[0].extensions.code).toBe('BAD_REQUEST');
    expect(neither.errors?.[0].message).toContain('exactly one');
    expect(both.errors?.[0].extensions.code).toBe('BAD_REQUEST');
  });
});

function validBody() {
  return { valid: true, grantMicros: String(GRANT_MICROS), campaign: CAMPAIGN };
}

/**
 * Invite-only registration, end to end (SUP-173).
 *
 * The assertion that matters is the same in every case and is made twice: the
 * request is refused, **and** the `user` table is no bigger than it was. A
 * refusal that answered 403 after inserting the row would pass any test that only
 * read the response, and would be exactly the half-created account the feature
 * exists to prevent.
 */
describe('a deployment that requires an invitation to sign up', () => {
  /** Better Auth owns the `user` table, so this counts through its own connection. */
  async function users(): Promise<number> {
    return dataSourceOf(harness)
      .query('select count(*) as n from user')
      .then((rows) => Number(rows[0].n));
  }

  async function requireInvites(env: Record<string, string> = {}): Promise<void> {
    await inviteHarness({ CR_API_AUTH__REQUIRE_INVITE_FOR_SIGN_UP: 'true', ...env });
  }

  describe('the emailed-code path', () => {
    beforeEach(async () => {
      await requireInvites();
    });

    it('creates the account and credits it when the code is good', async () => {
      const [invite] = await issue(dataSourceOf(harness));

      const created = await signUp({
        email: 'invited@example.com',
        name: 'Invited',
        inviteCode: invite.code,
      }).expect(200);

      const session = await consoleSession(sessionCookiesOf(created));
      const grant = await expectData(session, INVITE_GRANT);
      expect(grant.inviteGrant).toMatchObject({ grantMicros: String(GRANT_MICROS), campaign: CAMPAIGN });
    });

    it('refuses a sign-up with no code at all, and creates nothing', async () => {
      const before = await users();

      const refused = await signUp({ email: 'uninvited@example.com', name: 'Uninvited' }).expect(403);

      expect(refused.body.code).toBe('invite_required');
      expect(await users()).toBe(before);
    });

    it('tells a spent code apart from every other bad one, because that is the one a visitor can act on', async () => {
      const dataSource = dataSourceOf(harness);
      const [spent] = await issue(dataSource, { campaign: 'spent-c' });
      await dataSource.getRepository(InviteCode).update({ campaign: 'spent-c' }, { redemptionCount: 1 });
      const [expired] = await issue(dataSource, { expiresAt: new Date('2020-01-01T00:00:00Z'), campaign: 'exp-c' });
      const [disabled] = await issue(dataSource, { campaign: 'dis-c' });
      await dataSource.getRepository(InviteCode).update({ campaign: 'dis-c' }, { disabledAt: new Date() });

      const cases: [string, string][] = [
        [spent.code, 'invite_already_claimed'],
        [expired.code, 'invite_expired_or_unknown'],
        [disabled.code, 'invite_expired_or_unknown'],
        [formatInviteCode(mintInviteCode()), 'invite_expired_or_unknown'],
        ['not-a-code-at-all', 'invite_expired_or_unknown'],
      ];

      const before = await users();
      let index = 0;
      for (const [code, expected] of cases) {
        const refused = await signUp({
          email: `refused-${index}@example.com`,
          name: 'Refused',
          inviteCode: code,
        }).expect(403);
        index += 1;
        expect(refused.body.code, code).toBe(expected);
      }
      expect(await users()).toBe(before);
    });

    it('spends the code exactly once, so the second person to try it is turned away', async () => {
      const [invite] = await issue(dataSourceOf(harness));

      await signUp({ email: 'first@example.com', inviteCode: invite.code, name: 'First' }).expect(200);
      const before = await users();
      const second = await signUp({
        email: 'second@example.com',
        inviteCode: invite.code,
        name: 'Second',
      }).expect(403);

      expect(second.body.code).toBe('invite_already_claimed');
      expect(await users()).toBe(before);
    });

    it('leaves signing in to an existing account alone', async () => {
      const [invite] = await issue(dataSourceOf(harness));
      await signUp({ email: 'returning@example.com', inviteCode: invite.code, name: 'R' }).expect(200);

      // No code on this request, and the one it was created with is spent.
      await signUp({ email: 'returning@example.com' }).expect(200);
    });
  });

  describe('the magic-link path', () => {
    beforeEach(async () => {
      await requireInvites();
    });

    it('creates the account when the code rode the callbackURL', async () => {
      const [invite] = await issue(dataSourceOf(harness));

      await request(server())
        .post('/auth/sign-in/magic-link')
        .send({ email: 'magic@example.com', callbackURL: `/?invite=${encodeURIComponent(invite.code)}` });
      const verified = await request(server()).get(pathOf(harness.mailer.last.url));

      const session = await consoleSession(sessionCookiesOf(verified));
      expect((await expectData(session, INVITE_GRANT)).inviteGrant).toMatchObject({
        grantMicros: String(GRANT_MICROS),
      });
    });

    /**
     * A navigation cannot be answered with a 403 body, so the refusal comes back
     * as `?error=` on the error callback — the same three codes the password path
     * puts in its body, which is what lets the console have one set of copy.
     */
    it('redirects to the error callback with the code, and creates nothing', async () => {
      const before = await users();

      await request(server())
        .post('/auth/sign-in/magic-link')
        .send({ email: 'nocode@example.com', callbackURL: '/', errorCallbackURL: '/signup' });
      const verified = await request(server()).get(pathOf(harness.mailer.last.url)).expect(302);

      const location = new URL(verified.headers.location, 'http://localhost:3000');
      expect(location.pathname).toBe('/signup');
      expect(location.searchParams.get('error')).toBe('invite_required');
      expect(await users()).toBe(before);
    });

    it('carries the claimed-already refusal the same way', async () => {
      const dataSource = dataSourceOf(harness);
      const [spent] = await issue(dataSource);
      await dataSource.getRepository(InviteCode).update({ code: spent.code.replace(/-/g, '') }, { redemptionCount: 1 });

      await request(server())
        .post('/auth/sign-in/magic-link')
        .send({ email: 'spent@example.com', callbackURL: `/?invite=${spent.code}`, errorCallbackURL: '/signup' });
      const verified = await request(server()).get(pathOf(harness.mailer.last.url)).expect(302);

      expect(new URL(verified.headers.location, 'http://localhost:3000').searchParams.get('error')).toBe(
        'invite_already_claimed',
      );
    });
  });

  describe('the operator’s own way in', () => {
    it('lets the bootstrap token claim the deployment, which no invitation could cover', async () => {
      await requireInvites({ CR_API_AUTH__BOOTSTRAP_TOKEN: 'bootstrap-token-'.padEnd(40, 'x') });

      await request(server())
        .post('/auth/bootstrap')
        .send({ token: 'bootstrap-token-'.padEnd(40, 'x') })
        .expect(200);

      expect(await users()).toBe(1);
    });
  });

  describe('the console’s public answer', () => {
    it('reports the requirement, so the sign-up screen can say so before anyone tries', async () => {
      await requireInvites();

      const options = await expectData(anonymous(harness), '{ signInOptions { inviteRequired emailCode } }');

      expect(options.signInOptions).toMatchObject({ inviteRequired: true, emailCode: true });
    });

    it('reports it off on a deployment that did not ask for it — the demo stand’s default', async () => {
      await inviteHarness();

      const options = await expectData(anonymous(harness), '{ signInOptions { inviteRequired } }');

      expect(options.signInOptions.inviteRequired).toBe(false);
    });
  });
});

describe('a deployment that does not require an invitation', () => {
  beforeEach(async () => {
    await inviteHarness();
  });

  it('still creates the account when the code is no good — the behaviour SUP-142 chose', async () => {
    const created = await signUp({
      email: 'nocode-open@example.com',
      name: 'Open',
      inviteCode: formatInviteCode(mintInviteCode()),
    }).expect(200);

    const session = await consoleSession(sessionCookiesOf(created));
    const grant = await expectData(session, INVITE_GRANT);
    expect(grant.inviteGrant).toBeNull();
  });
});
