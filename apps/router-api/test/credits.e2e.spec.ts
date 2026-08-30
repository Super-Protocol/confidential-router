import Stripe from 'stripe';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CreditTransaction } from '../src/app/db/entities/credit-transaction.entity.js';
import { Workspace } from '../src/app/db/entities/workspace.entity.js';
import { createHarness, type Harness } from './app-harness.js';
import { anonymous, type ConsoleSession, dataSourceOf, expectData, graphql, signIn } from './console.js';

/**
 * The Credits screen end to end: a top-up that only becomes credit once the
 * provider confirms it, a ledger that adds up, and a webhook that can be
 * redelivered without charging twice.
 */

const BALANCE = `
  query Balance($workspaceId: ID!) {
    creditBalance(workspaceId: $workspaceId) {
      balanceMicros
      spendable
      minTopUpMicros
      autoTopUp { enabled thresholdMicros amountMicros available }
    }
  }
`;

const LEDGER = `
  query Ledger($workspaceId: ID!, $first: Int!, $after: String) {
    creditTransactions(workspaceId: $workspaceId, first: $first, after: $after) {
      totalCount
      pageInfo { hasNextPage endCursor }
      edges { node { kind amountMicros reference description } }
    }
  }
`;

const CHECKOUT = `
  mutation Checkout($input: CreateCheckoutInput!) {
    createCheckout(input: $input) { url ref }
  }
`;

const SET_AUTO_TOP_UP = `
  mutation SetAutoTopUp($input: SetAutoTopUpInput!) {
    setAutoTopUp(input: $input) { autoTopUp { enabled thresholdMicros amountMicros } }
  }
`;

let harness: Harness;
let session: ConsoleSession;

beforeAll(async () => {
  harness = await createHarness();
  session = await signIn(harness, 'credits@example.com');
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

function server() {
  return harness.app.getHttpServer();
}

/** Runs a manual checkout to completion, the way a browser would. */
async function topUp(amountMicros: string): Promise<void> {
  const data = await expectData(session, CHECKOUT, {
    input: { workspaceId: session.workspaceId, amountMicros },
  });
  const url = new URL(data.createCheckout.url);
  await request(server())
    .get(`${url.pathname}${url.search}`)
    .expect(303)
    .expect('Location', /topup=success/);
}

describe('a top-up', () => {
  it('starts at zero and is not spendable', async () => {
    const data = await expectData(session, BALANCE, { workspaceId: session.workspaceId });

    expect(data.creditBalance).toMatchObject({ balanceMicros: '0', spendable: false, minTopUpMicros: '5000000' });
  });

  it('credits nothing until the checkout is completed', async () => {
    await expectData(session, CHECKOUT, {
      input: { workspaceId: session.workspaceId, amountMicros: '20000000' },
    });
    const data = await expectData(session, BALANCE, { workspaceId: session.workspaceId });

    expect(data.creditBalance.balanceMicros).toBe('0');
  });

  it('credits the workspace once the provider confirms', async () => {
    await topUp('20000000');
    const data = await expectData(session, BALANCE, { workspaceId: session.workspaceId });

    expect(data.creditBalance).toMatchObject({ balanceMicros: '20000000', spendable: true });
  });

  it('appears in the ledger as a purchase', async () => {
    const data = await expectData(session, LEDGER, { workspaceId: session.workspaceId, first: 10 });

    expect(data.creditTransactions.edges[0].node).toMatchObject({ kind: 'PURCHASE', amountMicros: '20000000' });
  });

  it('refuses an amount below the configured minimum', async () => {
    const body = await graphql(session, CHECKOUT, {
      input: { workspaceId: session.workspaceId, amountMicros: '1000000' },
    });

    expect(body.errors[0].message).toMatch(/minimum top-up/i);
  });

  it('refuses an amount that is not a whole number of cents', async () => {
    const body = await graphql(session, CHECKOUT, {
      input: { workspaceId: session.workspaceId, amountMicros: '5000001' },
    });

    expect(body.errors[0].message).toMatch(/whole number of cents/i);
  });

  it('completes each signed link only once, whatever a reload does', async () => {
    const data = await expectData(session, CHECKOUT, {
      input: { workspaceId: session.workspaceId, amountMicros: '5000000' },
    });
    const url = new URL(data.createCheckout.url);
    const path = `${url.pathname}${url.search}`;

    await request(server()).get(path).expect(303);
    await request(server()).get(path).expect(303);

    const balance = await expectData(session, BALANCE, { workspaceId: session.workspaceId });
    expect(balance.creditBalance.balanceMicros).toBe('25000000');
  });
});

describe('the ledger', () => {
  it('pages newest first and reports a total', async () => {
    const first = await expectData(session, LEDGER, { workspaceId: session.workspaceId, first: 1 });

    expect(first.creditTransactions.totalCount).toBe(2);
    expect(first.creditTransactions.pageInfo.hasNextPage).toBe(true);
    expect(first.creditTransactions.edges[0].node.amountMicros).toBe('5000000');

    const second = await expectData(session, LEDGER, {
      workspaceId: session.workspaceId,
      first: 5,
      after: first.creditTransactions.pageInfo.endCursor,
    });
    expect(second.creditTransactions.edges).toHaveLength(1);
    expect(second.creditTransactions.pageInfo.hasNextPage).toBe(false);
  });

  it('always equals the cached balance', async () => {
    const dataSource = dataSourceOf(harness);
    const entries = await dataSource.getRepository(CreditTransaction).findBy({ workspaceId: session.workspaceId });
    const workspace = await dataSource.getRepository(Workspace).findOneByOrFail({ id: session.workspaceId });

    expect(workspace.balanceMicros).toBe(entries.reduce((sum, entry) => sum + entry.amountMicros, 0));
  });
});

describe('automatic top-up', () => {
  it('needs both a threshold and an amount to be turned on', async () => {
    const body = await graphql(session, SET_AUTO_TOP_UP, {
      input: { workspaceId: session.workspaceId, settings: { enabled: true } },
    });

    expect(body.errors[0].message).toMatch(/threshold and an amount/i);
  });

  it('stores the settings and reports them back', async () => {
    const data = await expectData(session, SET_AUTO_TOP_UP, {
      input: {
        workspaceId: session.workspaceId,
        settings: { enabled: true, thresholdMicros: '5000000', amountMicros: '20000000' },
      },
    });

    expect(data.setAutoTopUp.autoTopUp).toEqual({
      enabled: true,
      thresholdMicros: '5000000',
      amountMicros: '20000000',
    });
  });

  it('clears the thresholds when turned off', async () => {
    const data = await expectData(session, SET_AUTO_TOP_UP, {
      input: { workspaceId: session.workspaceId, settings: { enabled: false } },
    });

    expect(data.setAutoTopUp.autoTopUp).toEqual({ enabled: false, thresholdMicros: null, amountMicros: null });
  });
});

describe('tenancy', () => {
  it('refuses a workspace the caller is not a member of', async () => {
    const other = await signIn(harness, 'stranger@example.com');

    const body = await graphql(other, BALANCE, { workspaceId: session.workspaceId });

    expect(body.errors[0].message).toMatch(/do not have access/i);
  });

  it('refuses an anonymous caller', async () => {
    const body = await graphql(anonymous(harness), BALANCE, { workspaceId: session.workspaceId });

    expect(body.errors[0].message).toMatch(/Authentication is required/);
  });
});

describe('the Stripe webhook', () => {
  const SECRET_KEY = 'sk_test_00000000000000000000000000';
  const WEBHOOK_SECRET = 'whsec_e2e_secret';

  let stripeHarness: Harness;
  let stripeSession: ConsoleSession;
  const stripe = new Stripe(SECRET_KEY);

  beforeAll(async () => {
    stripeHarness = await createHarness({
      env: {
        CR_API_BILLING__STRIPE__SECRET_KEY: SECRET_KEY,
        CR_API_BILLING__STRIPE__WEBHOOK_SECRET: WEBHOOK_SECRET,
      },
    });
    stripeSession = await signIn(stripeHarness, 'stripe@example.com');
  }, 60_000);

  afterAll(async () => {
    await stripeHarness?.close();
  });

  /** A `checkout.session.completed` delivery, signed the way Stripe signs it. */
  function delivery(eventId: string, paymentIntent: string): { payload: string; signature: string } {
    const payload = JSON.stringify({
      id: eventId,
      object: 'event',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_e2e',
          client_reference_id: stripeSession.workspaceId,
          payment_status: 'paid',
          amount_total: 2_000,
          payment_intent: paymentIntent,
          customer: 'cus_e2e',
        },
      },
    });
    return { payload, signature: stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET }) };
  }

  function post(delivered: { payload: string; signature: string }) {
    return request(stripeHarness.app.getHttpServer())
      .post('/billing/stripe/webhook')
      .set('stripe-signature', delivered.signature)
      .set('Content-Type', 'application/json')
      .send(delivered.payload);
  }

  it('rejects an unsigned delivery', async () => {
    await request(stripeHarness.app.getHttpServer())
      .post('/billing/stripe/webhook')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ id: 'evt_x' }))
      .expect(401);
  });

  it('credits the ledger for a paid checkout', async () => {
    await post(delivery('evt_1', 'pi_e2e_1')).expect(200);

    const data = await expectData(stripeSession, BALANCE, { workspaceId: stripeSession.workspaceId });
    expect(data.creditBalance.balanceMicros).toBe('20000000');
  });

  it('does not credit twice when Stripe redelivers the same payment', async () => {
    // A different event id for the same payment: Stripe retries deliveries and
    // emits several event types per payment, and neither may double the credit.
    await post(delivery('evt_2', 'pi_e2e_1')).expect(200);

    const data = await expectData(stripeSession, BALANCE, { workspaceId: stripeSession.workspaceId });
    expect(data.creditBalance.balanceMicros).toBe('20000000');
  });

  it('remembers the Stripe customer, so auto top-up has a card to charge', async () => {
    const workspace = await dataSourceOf(stripeHarness)
      .getRepository(Workspace)
      .findOneByOrFail({ id: stripeSession.workspaceId });

    expect(workspace.stripeCustomerId).toBe('cus_e2e');
  });
});
