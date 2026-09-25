import request from 'supertest';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InviteCode } from '../src/app/db/entities/invite-code.entity.js';
import { formatInviteCode, generateInvites, mintInviteCode } from '../src/app/invites/index.js';
import { createHarness, type Harness, pathOf } from './app-harness.js';
import { type ConsoleSession, dataSourceOf, expectData, graphql } from './console.js';

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
const PASSWORD = 'correct-horse-battery';

const INVITE_GRANT = '{ inviteGrant { grantMicros campaign creditTransactionId redeemedAt } }';
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

/** A deployment with password sign-up, so a test can create an account in one call. */
async function inviteHarness(env: Record<string, string> = {}): Promise<Harness> {
  harness = await createHarness({
    env: {
      CR_API_AUTH__PASSWORD__ENABLED: 'true',
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
  return request(server()).post(`/auth/sign-up/email${query}`).send(body);
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
      password: PASSWORD,
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
      password: PASSWORD,
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
      { email: 'query@example.com', password: PASSWORD, name: 'Query' },
      `?invite=${encodeURIComponent(invite.code)}`,
    ).expect(200);

    const grant = await expectData(await consoleSession(sessionCookiesOf(created)), INVITE_GRANT);
    expect(grant.inviteGrant).toMatchObject({ campaign: CAMPAIGN });
  });

  it('spends the code: the lookup stops offering it', async () => {
    const [invite] = await issue(dataSourceOf(harness));
    await lookup(invite.code).expect(200).expect(validBody());

    await signUp({ email: 'first@example.com', password: PASSWORD, name: 'First', inviteCode: invite.code }).expect(
      200,
    );

    await lookup(invite.code).expect(200).expect({ valid: false, reason: 'unavailable' });
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
    await signUp({ email: 'first@example.com', password: PASSWORD, name: 'First', inviteCode: invite.code }).expect(
      200,
    );

    await expectAccountWithoutCredit(
      await signUp({ email: 'second@example.com', password: PASSWORD, name: 'Second', inviteCode: invite.code }),
    );
  });

  it('still creates the account for outright garbage', async () => {
    await expectAccountWithoutCredit(
      await signUp({ email: 'garbage@example.com', password: PASSWORD, name: 'Garbage', inviteCode: 'ZZZZ-ZZZZ-ZZZZ' }),
    );
  });

  it('still creates the account when the code is not even code-shaped', async () => {
    await expectAccountWithoutCredit(
      await signUp({
        email: 'nonsense@example.com',
        password: PASSWORD,
        name: 'Nonsense',
        inviteCode: '../../etc/passwd',
      }),
    );
  });

  it('still creates the account when the code expired', async () => {
    const [invite] = await issue(dataSourceOf(harness), { expiresAt: new Date('2020-01-01T00:00:00Z') });

    await expectAccountWithoutCredit(
      await signUp({ email: 'expired@example.com', password: PASSWORD, name: 'Expired', inviteCode: invite.code }),
    );
  });

  it('cannot be topped up by signing in again with another code', async () => {
    const dataSource = dataSourceOf(harness);
    const [first] = await issue(dataSource);
    const [second] = await issue(dataSource, { campaign: 'launch-2026-11' });
    const created = await signUp({
      email: 'twice@example.com',
      password: PASSWORD,
      name: 'Twice',
      inviteCode: first.code,
    }).expect(200);
    const session = await consoleSession(sessionCookiesOf(created));

    // Redemption lives in account creation, so the second sign-in has nothing to
    // redeem with — which is the property that makes the grant unreplayable.
    await request(server())
      .post(`/auth/sign-in/email?invite=${encodeURIComponent(second.code)}`)
      .send({ email: 'twice@example.com', password: PASSWORD })
      .expect(200);

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

describe('the campaign stats query', () => {
  it('answers an operator, and refuses everyone else', async () => {
    await inviteHarness({ CR_API_AUTH__ADMIN_EMAILS: 'ops@example.com' });
    const dataSource = dataSourceOf(harness);
    const invites = await issue(dataSource, { count: 4 });
    const redeemed = await signUp({
      email: 'redeemer@example.com',
      password: PASSWORD,
      name: 'Redeemer',
      inviteCode: invites[0].code,
    }).expect(200);

    const operator = await consoleSession(
      sessionCookiesOf(await signUp({ email: 'ops@example.com', password: PASSWORD, name: 'Ops' }).expect(200)),
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

function validBody() {
  return { valid: true, grantMicros: String(GRANT_MICROS), campaign: CAMPAIGN };
}
