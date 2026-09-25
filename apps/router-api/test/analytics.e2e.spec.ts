import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LedgerService } from '../src/app/billing/index.js';
import { generateInvites } from '../src/app/invites/index.js';
import { createHarness, type Harness, pathOf } from './app-harness.js';
import { dataSourceOf, expectData, graphql } from './console.js';
import { bearer, routerConfigFor } from './gateway-fixture.js';
import { MockLiteLlm } from './mock-litellm.js';

/**
 * The launch funnel, end to end, against the real application.
 *
 * `docs/contracts/analytics-events.md` says of its rehearsal that "a step that
 * does not appear is a bug in the emitter, not in the tool" — this is where that
 * is checkable without a PostHog project: the harness swaps the sink for a
 * recorder and every emitter is the production one, wired into the production
 * module graph.
 *
 * Four properties are worth stating, because each is a thing that has been got
 * wrong in an analytics implementation before:
 *
 *  - the events exist only for accounts that exist — they are emitted from inside
 *    the sign-up hook, not from a client callback;
 *  - `signup_started` is anonymous, and stays anonymous;
 *  - `first_request_sent` fires once per workspace however many requests arrive;
 *  - a refused redemption is reported, because a campaign whose codes were all
 *    spent looks identical to one nobody opened unless refusals are counted.
 */

const GRANT_MICROS = 100_000_000;
const CAMPAIGN = 'launch-2026-10-devs';
const PASSWORD = 'correct-horse-battery';
const CHAT = { model: 'mock/chat:tdx', messages: [{ role: 'user', content: 'Hello there' }] };

const upstream = new MockLiteLlm();
let harness: Harness;

beforeAll(async () => {
  const baseUrl = await upstream.start();
  harness = await createHarness({
    config: routerConfigFor(baseUrl),
    env: { CR_API_AUTH__PASSWORD__ENABLED: 'true', CR_API_AUTH__ADMIN_EMAILS: 'ops@example.com' },
  });
}, 60_000);

afterAll(async () => {
  await harness?.close();
  await upstream.stop();
});

beforeEach(() => {
  upstream.reset();
});

afterEach(() => {
  harness.events.reset();
});

function server() {
  return harness.app.getHttpServer();
}

function issue(overrides: Partial<Parameters<typeof generateInvites>[1]> = {}) {
  return generateInvites(dataSourceOf(harness), {
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

function cookiesOf(response: request.Response): string[] {
  const cookies = response.headers['set-cookie'];
  return (Array.isArray(cookies) ? cookies : [cookies].filter(Boolean)) as string[];
}

/** One account, created the way the console creates one. */
async function signUp(email: string, inviteCode?: string): Promise<{ cookies: string[]; workspaceId: string }> {
  const created = await request(server())
    .post('/auth/sign-up/email')
    .send({ email, password: PASSWORD, name: 'Funnel', ...(inviteCode ? { inviteCode } : {}) })
    .expect(200);
  const cookies = cookiesOf(created);
  const me = await graphql({ harness, cookies, email, workspaceId: '' }, '{ me { workspaces { id } } }');
  return { cookies, workspaceId: me.data.me.workspaces[0].id };
}

function post(body: Record<string, unknown>) {
  return request(server()).post('/v1/analytics/events').send(body);
}

describe('POST /v1/analytics/events', () => {
  it('records signup_started anonymously, with the properties the taxonomy declares', async () => {
    await post({
      event: 'signup_started',
      properties: { has_invite: true, campaign: CAMPAIGN, utm_campaign: 'launch', entry: 'landing_cta' },
    }).expect(202);

    const event = harness.events.one('signup_started');
    expect(event).toMatchObject({
      anonymous: true,
      person: {},
      properties: { has_invite: true, campaign: CAMPAIGN, utm_campaign: 'launch', entry: 'landing_cta' },
    });
  });

  it('stays anonymous even for a visitor who already holds a session', async () => {
    const { cookies } = await signUp('already-in@example.com');
    harness.events.reset();

    await post({ event: 'signup_started', properties: { has_invite: false, entry: 'direct' } })
      .set('Cookie', cookies)
      .expect(202);

    // Identifying it would need a value stored in the browser to stitch the
    // landing visit to the account — exactly what ADR-006 §4 rules out.
    expect(harness.events.one('signup_started').anonymous).toBe(true);
  });

  it('refuses an event the browser is not allowed to assert', async () => {
    // Everything else about an account is something the server already knows,
    // and an event the server can derive is one a client must not assert.
    await post({ event: 'invite_redeemed', properties: { outcome: 'granted' } }).expect(400);
    await post({ event: 'first_request_sent' }).expect(400);
    await post({ event: 'anything_at_all' }).expect(400);

    expect(harness.events.sent).toEqual([]);
  });

  it('refuses an identified event with no session rather than recording it anonymously', async () => {
    await post({ event: 'feedback_form_opened', properties: { source: 'credits_page' } }).expect(401);

    expect(harness.events.sent).toEqual([]);
  });

  it('keeps out an undeclared property, a long string and a nested object', async () => {
    await post({
      event: 'signup_started',
      properties: {
        entry: 'direct',
        has_invite: false,
        email: 'someone@example.com',
        campaign: 'x'.repeat(500),
        nested: { anything: 'at all' },
      },
    }).expect(202);

    // The allow-list is what keeps a public endpoint from being a way to write
    // arbitrary rows into our analytics.
    expect(harness.events.one('signup_started').properties).toEqual({ entry: 'direct', has_invite: false });
  });

  it('is never cached, and is reached before the /v1 fallback', async () => {
    const response = await post({ event: 'signup_started', properties: { entry: 'direct', has_invite: false } }).expect(
      202,
    );

    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.text).toBe('');
    const unknown = await request(server()).post('/v1/analytics/anything-else').send({}).expect(404);
    expect(unknown.body.error.code).toBe('not_found');
  });
});

describe('the ingest rate limit', () => {
  it('refuses a caller past its minute budget on a budget of its own', async () => {
    const limited = await createHarness({
      env: { CR_API_AUTH__PASSWORD__ENABLED: 'true', CR_API_ANALYTICS__INGEST_PER_MINUTE: '2' },
    });
    try {
      const event = { event: 'signup_started', properties: { entry: 'direct', has_invite: false } };
      const send = () => request(limited.app.getHttpServer()).post('/v1/analytics/events').send(event);

      await send().expect(202);
      await send().expect(202);
      const refused = await send().expect(429);

      expect(refused.headers['retry-after']).toBeDefined();
      // The invitation lookup has its own bucket and is untouched by that.
      await request(limited.app.getHttpServer()).get('/v1/invites/ZZZZ-ZZZZ-ZZZZ').expect(200);
    } finally {
      await limited.close();
    }
  }, 60_000);
});

describe('the sign-up events', () => {
  it('reports the sign-up and the grant, against the new account', async () => {
    const [invite] = await issue();

    const { workspaceId } = await signUp('funnel@example.com', invite.code);

    expect(harness.events.one('signup_completed')).toMatchObject({
      anonymous: false,
      properties: { has_invite: true, campaign: CAMPAIGN, method: 'password' },
      // The first identified event of the account's life, so also where the two
      // allowed person properties are set. No email, no name (ADR-006 §4).
      person: { campaign: CAMPAIGN, signup_method: 'password' },
    });
    expect(harness.events.one('invite_redeemed')).toMatchObject({
      properties: { outcome: 'granted', campaign: CAMPAIGN, grant_micros: GRANT_MICROS },
    });

    const signUpEvent = harness.events.one('signup_completed');
    const redeemed = harness.events.one('invite_redeemed');
    // Both name the same account, which is what joins the funnel's PostHog half.
    expect(redeemed.distinctId).toBe(signUpEvent.distinctId);
    expect(workspaceId).toBeTruthy();
  });

  it('sends nothing about invitations when the sign-up carried no code', async () => {
    await signUp('organic@example.com');

    expect(harness.events.one('signup_completed').properties).toMatchObject({ has_invite: false });
    // A `refused` row for every organic sign-up would make the campaign's
    // refusal rate meaningless.
    expect(harness.events.all('invite_redeemed')).toEqual([]);
  });

  it('reports a refusal with its reason, which is the number a dead campaign shows up in', async () => {
    const [invite] = await issue({ expiresAt: new Date('2020-01-01T00:00:00Z') });

    await signUp('expired@example.com', invite.code);

    expect(harness.events.one('invite_redeemed').properties).toEqual({ outcome: 'refused', reason: 'expired' });
    // The registration still succeeded, and the event says the code did not.
    expect(harness.events.one('signup_completed').properties).toMatchObject({ has_invite: true });
  });

  it('names the sign-in path that created the account', async () => {
    await request(server()).post('/auth/sign-in/magic-link').send({ email: 'magic@example.com', callbackURL: '/' });
    await request(server()).get(pathOf(harness.mailer.last.url));

    expect(harness.events.one('signup_completed').properties).toMatchObject({ method: 'magic_link' });
  });
});

describe('the activation events', () => {
  it('reports the first key with the count that separates activation from habit', async () => {
    const [invite] = await issue({ campaign: 'keys-campaign' });
    const session = { harness, ...(await signUp('keys@example.com', invite.code)), email: 'keys@example.com' };
    harness.events.reset();

    const created = await expectData(
      session,
      'mutation Create($input: CreateApiKeyInput!) { createApiKey(input: $input) { key { id } secret } }',
      { input: { workspaceId: session.workspaceId, name: 'first key', spendLimitMicros: '5000000' } },
    );

    expect(harness.events.one('api_key_created')).toMatchObject({
      properties: { campaign: 'keys-campaign', has_spend_limit: true, keys_after: 1 },
    });
    // Neither the secret nor the label is anywhere in the event.
    const event = harness.events.one('api_key_created');
    expect(JSON.stringify(event)).not.toContain(created.createApiKey.secret);
    expect(JSON.stringify(event)).not.toContain('first key');
  });

  it('reports the first metered request once per workspace, and no second time', async () => {
    const [invite] = await issue({ campaign: 'activation-campaign' });
    const session = { harness, ...(await signUp('activate@example.com', invite.code)), email: 'activate@example.com' };
    const created = await expectData(
      session,
      'mutation Create($input: CreateApiKeyInput!) { createApiKey(input: $input) { secret } }',
      { input: { workspaceId: session.workspaceId, name: 'gateway key' } },
    );
    harness.events.reset();

    await request(server())
      .post('/v1/chat/completions')
      .set(bearer(created.createApiKey.secret))
      .send(CHAT)
      .expect(200);

    expect(harness.events.one('first_request_sent')).toMatchObject({
      properties: {
        campaign: 'activation-campaign',
        had_invite_grant: true,
        model_slug: 'mock/chat:tdx',
        hours_since_signup: 0,
      },
    });

    await request(server())
      .post('/v1/chat/completions')
      .set(bearer(created.createApiKey.secret))
      .send(CHAT)
      .expect(200);
    // "Exactly once per workspace" is a property of the conditional UPDATE that
    // claims `firstRequestAt`, not of a count of generations.
    expect(harness.events.all('first_request_sent')).toHaveLength(1);
  });

  it('says so when the workspace never redeemed anything', async () => {
    const session = { harness, ...(await signUp('paying@example.com')), email: 'paying@example.com' };
    // No grant, so the balance has to come from somewhere: a purchase, through
    // the ledger, exactly as a paying customer's would.
    await harness.app.get(LedgerService).record({
      workspaceId: session.workspaceId,
      kind: 'purchase',
      amountMicros: 10_000_000,
      idempotencyKey: 'test:purchase:paying',
    });
    const created = await expectData(
      session,
      'mutation Create($input: CreateApiKeyInput!) { createApiKey(input: $input) { secret } }',
      { input: { workspaceId: session.workspaceId, name: 'organic key' } },
    );
    harness.events.reset();

    await request(server())
      .post('/v1/chat/completions')
      .set(bearer(created.createApiKey.secret))
      .send(CHAT)
      .expect(200);

    const event = harness.events.one('first_request_sent');
    // `had_invite_grant` is the split that says whether the $100 did anything.
    expect(event.properties.had_invite_grant).toBe(false);
    expect('campaign' in event.properties).toBe(false);
  });
});

describe('the whole funnel, and the code that is spent', () => {
  it('runs from an invitation URL to a metered request with exactly one grant', async () => {
    const [invite] = await issue({ campaign: 'rehearsal' });
    const code = new URL(invite.url).searchParams.get('invite') as string;

    // 1. The landing page's last observable step is the click; the console's
    //    first is the sign-up screen it lands on.
    await post({
      event: 'signup_started',
      properties: { has_invite: true, campaign: 'rehearsal', entry: 'landing_cta' },
    }).expect(202);

    // 2. Sign-up, with the code the URL carried.
    const session = { harness, ...(await signUp('rehearsal@example.com', code)), email: 'rehearsal@example.com' };

    // 3. A key, then one request.
    const created = await expectData(
      session,
      'mutation Create($input: CreateApiKeyInput!) { createApiKey(input: $input) { secret } }',
      { input: { workspaceId: session.workspaceId, name: 'rehearsal key' } },
    );
    await request(server())
      .post('/v1/chat/completions')
      .set(bearer(created.createApiKey.secret))
      .send(CHAT)
      .expect(200);

    expect(harness.events.sent.map((event) => event.event)).toEqual([
      'signup_started',
      'signup_completed',
      'invite_redeemed',
      'api_key_created',
      'first_request_sent',
    ]);

    // The ledger holds the grant and nothing but — the debit for the request is
    // the only other entry.
    const ledger = await expectData(
      session,
      `query Ledger($workspaceId: ID!) {
         creditTransactions(workspaceId: $workspaceId, first: 10) { edges { node { kind amountMicros reference } } }
       }`,
      { workspaceId: session.workspaceId },
    );
    const grants = ledger.creditTransactions.edges.filter(
      (edge: { node: { kind: string } }) => edge.node.kind === 'GRANT',
    );
    expect(grants).toHaveLength(1);
    expect(grants[0].node).toMatchObject({ amountMicros: String(GRANT_MICROS), reference: 'rehearsal' });

    // And the database agrees. When the tool and the tables disagree the tables
    // are right, so the rehearsal cross-checks one against the other.
    const operator = { harness, ...(await signUp('ops@example.com')), email: 'ops@example.com' };
    const stats = await expectData(
      operator,
      'query Stats($campaign: String) { inviteCampaigns(campaign: $campaign) { issued redeemed activated } }',
      { campaign: 'rehearsal' },
    );
    expect(stats.inviteCampaigns).toEqual([{ issued: 1, redeemed: 1, activated: 1 }]);
  });

  it('creates a second account from the same used URL, and grants it nothing', async () => {
    const [invite] = await issue({ campaign: 'one-seat' });
    await signUp('first-browser@example.com', invite.code);
    harness.events.reset();

    // The fresh browser: same URL, no session, no storage — the code is the only
    // thing it carries, and the code is spent.
    const second = { harness, ...(await signUp('fresh-browser@example.com', invite.code)), email: '' };

    expect(harness.events.one('invite_redeemed').properties).toEqual({ outcome: 'refused', reason: 'exhausted' });
    const balance = await expectData(
      second,
      `{ creditBalance(workspaceId: "${second.workspaceId}") { balanceMicros } }`,
    );
    expect(balance.creditBalance.balanceMicros).toBe('0');
  });
});
