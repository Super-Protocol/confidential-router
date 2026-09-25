import { createHmac } from 'node:crypto';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { afterEach, describe, expect, it } from 'vitest';
import { LedgerService } from '../src/app/billing/index.js';
import { generateInvites } from '../src/app/invites/index.js';
import { createHarness, type Harness } from './app-harness.js';
import { type ConsoleSession, dataSourceOf, expectData, graphql } from './console.js';
import { type Catalog, seedCatalog, seedGeneration } from './seed.js';

/**
 * The second grant, end to end: who is offered it, what a signed submission
 * does, and what a forged one does not.
 *
 * Every case boots the real application, because the properties that matter are
 * properties of the wiring. The webhook is authenticated by an HMAC over the
 * *raw* bytes, which only holds if `bootstrap.ts` mounted the raw body parser
 * ahead of the JSON one; and the grant has to land in the same ledger the
 * invitation grant used, through the same `LedgerService`.
 */

const INVITE_GRANT = 100_000_000;
const FEEDBACK_GRANT = 100_000_000;
const CAMPAIGN = 'launch-2026-10-devs';
const FORM_URL = 'https://superprotocol.typeform.com/to/aBcDeF';
const WEBHOOK_SECRET = 'e2e-feedback-webhook-secret';
const PASSWORD = 'correct-horse-battery';
const WEBHOOK_PATH = '/v1/webhooks/typeform';

const OFFER = '{ feedbackOffer { eligible reason grantMicros formUrl granted { grantMicros creditTransactionId } } }';
const LEDGER = `
  query Ledger($workspaceId: ID!) {
    creditBalance(workspaceId: $workspaceId) { balanceMicros }
    creditTransactions(workspaceId: $workspaceId, first: 10) {
      edges { node { kind amountMicros reference description } }
    }
  }
`;

let harness: Harness;

/**
 * Nothing in this suite may leave a workspace whose balance disagrees with its
 * ledger (`data-model.md` invariant 3) — checked on every case rather than on
 * the happy path alone, because a refusal that credited quietly is exactly the
 * bug worth catching.
 */
afterEach(async () => {
  if (harness) {
    const dataSource: DataSource = dataSourceOf(harness);
    const rows: { balance: number; ledger: number }[] = await dataSource.query(
      'SELECT w.balanceMicros AS balance, COALESCE(SUM(t.amountMicros), 0) AS ledger ' +
        'FROM workspaces w LEFT JOIN credit_transactions t ON t.workspaceId = w.id GROUP BY w.id',
    );
    for (const row of rows) {
      expect(Number(row.balance)).toBe(Number(row.ledger));
    }
  }
  await harness?.close();
  harness = undefined as unknown as Harness;
});

async function feedbackHarness(env: Record<string, string> = {}): Promise<Harness> {
  harness = await createHarness({
    env: {
      CR_API_AUTH__PASSWORD__ENABLED: 'true',
      CR_API_FEEDBACK__FORM__URL: FORM_URL,
      CR_API_FEEDBACK__FORM__WEBHOOK_SECRET: WEBHOOK_SECRET,
      CR_API_FEEDBACK__MIN_METERED_TOKENS: '1000',
      ...env,
    },
  });
  return harness;
}

function server() {
  return harness.app.getHttpServer();
}

interface Account extends ConsoleSession {
  catalog: Catalog;
}

/**
 * An account in the state the offer exists for: it redeemed an invitation, sent
 * requests, and has spent almost all of the $100.
 *
 * Every step goes through the running application — the sign-up hook applies the
 * invitation grant, `LedgerService` writes the usage debit — so the balance and
 * the ledger agree the way they would in production.
 */
async function seedSpentAccount(
  options: { email?: string; invited?: boolean; tokens?: number; leaveMicros?: number } = {},
): Promise<Account> {
  const dataSource = dataSourceOf(harness);
  const email = options.email ?? 'spent@example.com';
  const body: Record<string, unknown> = { email, password: PASSWORD, name: 'Spent' };

  if (options.invited !== false) {
    const [invite] = await generateInvites(dataSource, {
      count: 1,
      grantMicros: INVITE_GRANT,
      campaign: CAMPAIGN,
      maxRedemptions: 1,
      expiresAt: null,
      note: null,
      landingBaseUrl: 'https://router.superprotocol.com',
    });
    body.inviteCode = invite.code;
  }

  const created = await request(server()).post('/auth/sign-up/email').send(body).expect(200);
  const raw = created.headers['set-cookie'];
  const cookies = (Array.isArray(raw) ? raw : [raw].filter(Boolean)) as string[];
  const me = await graphql({ harness, cookies, email, workspaceId: '' }, '{ me { workspaces { id } } }');
  const workspaceId: string = me.data.me.workspaces[0].id;

  const catalog = await seedCatalog(dataSource);
  const tokens = options.tokens ?? 50_000;
  if (tokens > 0) {
    await seedGeneration(
      dataSource,
      { ...catalog, workspaceId },
      { createdAt: new Date(), promptTokens: Math.ceil(tokens / 2), completionTokens: Math.floor(tokens / 2) },
    );
  }

  const leave = options.leaveMicros ?? 1_000_000;
  if (options.invited !== false && leave < INVITE_GRANT) {
    await harness.app.get(LedgerService).record({
      workspaceId,
      kind: 'usage',
      amountMicros: -(INVITE_GRANT - leave),
      idempotencyKey: `e2e-usage:${workspaceId}`,
      reference: null,
      description: null,
    });
  }

  return { harness, cookies, email, workspaceId, catalog };
}

/** The bytes and header the form provider would have sent for one submission. */
function delivery(token: string, options: { submissionId?: string; secret?: string } = {}) {
  const body = Buffer.from(
    JSON.stringify({
      event_id: `evt-${options.submissionId ?? 'one'}`,
      event_type: 'form_response',
      form_response: {
        form_id: 'aBcDeF',
        token: options.submissionId ?? 'submission-1',
        submitted_at: '2026-09-25T12:34:56Z',
        hidden: { t: token },
        definition: { id: 'aBcDeF', fields: [{ id: 'q1', title: 'What did you build?' }] },
        answers: [{ field: { id: 'q1' }, type: 'text', text: 'A retrieval pipeline. It was fast.' }],
      },
    }),
    'utf8',
  );
  const signature = createHmac('sha256', options.secret ?? WEBHOOK_SECRET)
    .update(body)
    .digest('base64');
  return { body, signature: `sha256=${signature}` };
}

/**
 * Posts one delivery the way Typeform does: the exact bytes, plus the signature
 * header.
 *
 * The body goes out as a string rather than a `Buffer` because superagent treats
 * a Buffer as an object and reserialises it — which would change the bytes the
 * signature was computed over and make every case in this file fail for the one
 * reason it is not testing.
 */
function post(sent: { body: Buffer; signature: string }) {
  return request(server())
    .post(WEBHOOK_PATH)
    .set('Content-Type', 'application/json')
    .set('Typeform-Signature', sent.signature)
    .send(sent.body.toString('utf8'));
}

/** The token the console handed the browser, taken out of the form link. */
function tokenOf(formUrl: string): string {
  return new URL(formUrl).searchParams.get('t') as string;
}

async function offerFor(account: ConsoleSession) {
  return (await expectData(account, OFFER)).feedbackOffer;
}

async function ledgerOf(account: ConsoleSession) {
  return expectData(account, LEDGER, { workspaceId: account.workspaceId });
}

describe('who the console offers the second grant to', () => {
  it('offers it to an account that redeemed the first one, used it and ran it down', async () => {
    await feedbackHarness();
    const account = await seedSpentAccount();

    const offer = await offerFor(account);

    expect(offer.eligible).toBe(true);
    expect(offer.reason).toBeNull();
    expect(offer.grantMicros).toBe(String(FEEDBACK_GRANT));
    expect(offer.formUrl).toContain(FORM_URL);
    expect(tokenOf(offer.formUrl)).toBeTruthy();
    expect(offer.granted).toBeNull();
  });

  it('does not offer it to an account that never redeemed an invitation', async () => {
    await feedbackHarness();
    const account = await seedSpentAccount({ email: 'uninvited@example.com', invited: false });

    expect(await offerFor(account)).toMatchObject({ eligible: false, reason: 'NO_FIRST_GRANT', formUrl: null });
  });

  it('does not offer it while the account still has credit to spend', async () => {
    await feedbackHarness();
    const account = await seedSpentAccount({ email: 'rich@example.com', leaveMicros: INVITE_GRANT });

    expect(await offerFor(account)).toMatchObject({ eligible: false, reason: 'BALANCE_HEALTHY', formUrl: null });
  });

  it('does not offer it to an account that never sent a request', async () => {
    await feedbackHarness();
    const account = await seedSpentAccount({ email: 'idle@example.com', tokens: 0 });

    expect(await offerFor(account)).toMatchObject({ eligible: false, reason: 'NO_USAGE', formUrl: null });
  });

  it('offers nothing on a deployment with no form configured, and its webhook is a 404', async () => {
    harness = await createHarness({ env: { CR_API_AUTH__PASSWORD__ENABLED: 'true' } });
    const account = await seedSpentAccount({ email: 'nowhere@example.com' });

    expect(await offerFor(account)).toMatchObject({ eligible: false, reason: 'DISABLED', formUrl: null });
    await post(delivery('irrelevant')).expect(404);
  });

  it('refuses an anonymous caller', async () => {
    await feedbackHarness();

    const body = await graphql({ harness, cookies: [], email: '', workspaceId: '' }, OFFER);

    expect(body.errors[0].extensions.code).toBe('UNAUTHENTICATED');
  });
});

describe('a signed submission', () => {
  it('credits the account exactly once and names its origin in the ledger', async () => {
    await feedbackHarness();
    const account = await seedSpentAccount();
    const token = tokenOf((await offerFor(account)).formUrl);

    await post(delivery(token)).expect(200).expect({ outcome: 'granted' });

    const data = await ledgerOf(account);
    expect(data.creditBalance.balanceMicros).toBe(String(1_000_000 + FEEDBACK_GRANT));
    const grants = data.creditTransactions.edges
      .map((edge: { node: { kind: string; reference: string | null } }) => edge.node)
      .filter((node: { kind: string }) => node.kind === 'GRANT');
    expect(grants).toHaveLength(2);
    expect(grants.map((node: { reference: string | null }) => node.reference)).toContain('feedback');
    expect(grants.map((node: { reference: string | null }) => node.reference)).toContain(CAMPAIGN);
  });

  it('shows up on the offer as a grant already taken, so the console stops asking', async () => {
    await feedbackHarness();
    const account = await seedSpentAccount();
    await post(delivery(tokenOf((await offerFor(account)).formUrl))).expect(200);

    const offer = await offerFor(account);

    expect(offer).toMatchObject({ eligible: false, reason: 'ALREADY_GRANTED', formUrl: null });
    expect(offer.granted.grantMicros).toBe(String(FEEDBACK_GRANT));
  });

  it('grants once however many times the provider redelivers it', async () => {
    await feedbackHarness();
    const account = await seedSpentAccount();
    const sent = delivery(tokenOf((await offerFor(account)).formUrl));

    await post(sent).expect(200).expect({ outcome: 'granted' });
    await post(sent).expect(200).expect({ outcome: 'replayed' });
    await post(sent).expect(200).expect({ outcome: 'replayed' });

    const data = await ledgerOf(account);
    expect(data.creditBalance.balanceMicros).toBe(String(1_000_000 + FEEDBACK_GRANT));
  });

  it('refuses a second form from an account that already has its grant', async () => {
    await feedbackHarness();
    const account = await seedSpentAccount();
    const token = tokenOf((await offerFor(account)).formUrl);
    await post(delivery(token)).expect(200);

    await post(delivery(token, { submissionId: 'submission-2' }))
      .expect(200)
      .expect({ outcome: 'refused', reason: 'already_granted' });

    const data = await ledgerOf(account);
    expect(data.creditBalance.balanceMicros).toBe(String(1_000_000 + FEEDBACK_GRANT));
  });
});

describe('a forged submission', () => {
  it('grants nothing when the provider signature is wrong or missing', async () => {
    await feedbackHarness();
    const account = await seedSpentAccount();
    const token = tokenOf((await offerFor(account)).formUrl);

    await post(delivery(token, { secret: 'not-our-secret' })).expect(401);
    await request(server())
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .send(delivery(token).body.toString('utf8'))
      .expect(401);

    expect((await ledgerOf(account)).creditBalance.balanceMicros).toBe(String(1_000_000));
  });

  it('grants nothing when the body changed after it was signed', async () => {
    await feedbackHarness();
    const account = await seedSpentAccount();
    const sent = delivery(tokenOf((await offerFor(account)).formUrl));
    const tampered = Buffer.from(sent.body.toString('utf8').replace('submission-1', 'submission-9'), 'utf8');

    await post({ body: tampered, signature: sent.signature }).expect(401);

    expect((await ledgerOf(account)).creditBalance.balanceMicros).toBe(String(1_000_000));
  });

  it('grants nothing when the hidden token is missing or forged', async () => {
    await feedbackHarness();
    const account = await seedSpentAccount();

    // Correctly signed by the provider, so the only thing refusing it is our own
    // token — which is the half that says *which account* to credit.
    await post(delivery('')).expect(401);
    await post(delivery('bm90LWEtdG9rZW4.c2lnbmF0dXJl')).expect(401);

    expect((await ledgerOf(account)).creditBalance.balanceMicros).toBe(String(1_000_000));
    expect((await offerFor(account)).eligible).toBe(true);
  });

  it('grants nothing when the token has expired', async () => {
    await feedbackHarness({ CR_API_FEEDBACK__TOKEN_TTL: '1ms' });
    const account = await seedSpentAccount();
    const token = tokenOf((await offerFor(account)).formUrl);
    await new Promise((resolve) => setTimeout(resolve, 5));

    await post(delivery(token)).expect(401);

    expect((await ledgerOf(account)).creditBalance.balanceMicros).toBe(String(1_000_000));
  });
});

describe('the webhook route itself', () => {
  it('is reached before the /v1 fallback, which claims every other path under /v1', async () => {
    await feedbackHarness();
    const account = await seedSpentAccount();
    const token = tokenOf((await offerFor(account)).formUrl);

    await post(delivery(token)).expect(200);
    const unknown = await request(server()).post('/v1/webhooks/somebody-else').expect(404);
    expect(unknown.body.error.code).toBe('not_found');
  });

  it('refuses a caller that goes past its minute budget, and says when to retry', async () => {
    await feedbackHarness({ CR_API_FEEDBACK__WEBHOOKS_PER_MINUTE: '2' });
    const sent = delivery('irrelevant');

    // Unsigned deliveries still spend the budget: the point of the limit is that
    // an unsigned flood cannot make the service verify HMACs all day.
    await post({ ...sent, signature: 'sha256=wrong' }).expect(401);
    await post({ ...sent, signature: 'sha256=wrong' }).expect(401);
    const refused = await post({ ...sent, signature: 'sha256=wrong' }).expect(429);

    expect(refused.headers['retry-after']).toBeDefined();
  });

  it('ignores an event that is not a submission, rather than making the provider retry it', async () => {
    await feedbackHarness();
    const body = Buffer.from(JSON.stringify({ event_type: 'form_ping' }), 'utf8');
    const signature = `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(body).digest('base64')}`;

    await post({ body, signature }).expect(200).expect({ outcome: 'ignored' });
  });
});
