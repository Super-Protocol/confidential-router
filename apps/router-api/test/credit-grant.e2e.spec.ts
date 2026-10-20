import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OPERATOR_GRANT_REFERENCE } from '../src/app/billing/credit-grant.service.js';
import { CreditTransaction } from '../src/app/db/entities/credit-transaction.entity.js';
import { createHarness, type Harness } from './app-harness.js';
import { anonymous, type ConsoleSession, dataSourceOf, expectData, graphql, signIn } from './console.js';

/**
 * Putting credit on an existing account, over the real schema and the real
 * guards (SUP-406).
 *
 * The operator is the account `/auth/bootstrap` creates, which is how a
 * production deployment gets its first administrator — the same way
 * `invite-admin.e2e.spec.ts` gets one. The tester is an ordinary sign-up, so the
 * refusal case below is a real member session hitting `AdminGuard`, not a
 * hand-made token.
 */

const BOOTSTRAP_TOKEN = 'bootstrap-token-'.padEnd(40, 'x');
const OPERATOR = 'admin@confidential-router.local';
const TESTER = 'tester@example.com';
/** The schema default ceiling, $10 000. */
const CEILING = 10_000_000_000;

const GRANT = `
  mutation Grant($input: GrantCreditInput!) {
    grantCredit(input: $input) {
      creditTransactionId
      workspaceId
      accountEmail
      kind
      amountMicros
      balanceMicros
      note
      replayed
    }
  }
`;

const BALANCE = `
  query Balance($workspaceId: ID!) {
    creditBalance(workspaceId: $workspaceId) { balanceMicros spendable }
  }
`;

const LEDGER = `
  query Ledger($workspaceId: ID!) {
    creditTransactions(workspaceId: $workspaceId, first: 20) {
      totalCount
      edges { node { kind amountMicros reference description } }
    }
  }
`;

const SIGN_UPS = `
  query SignUps { adminSignUps { nodes { email workspaceId balanceMicros } } }
`;

let harness: Harness;
let operator: ConsoleSession;
let tester: ConsoleSession;

beforeEach(async () => {
  harness = await createHarness({
    env: { CR_API_AUTH__BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN, CR_API_AUTH__ADMIN_EMAILS: OPERATOR },
  });
  const claimed = await request(harness.app.getHttpServer())
    .post('/auth/bootstrap')
    .send({ token: BOOTSTRAP_TOKEN })
    .expect(200);
  const cookies = claimed.headers['set-cookie'];
  const session = {
    harness,
    cookies: (Array.isArray(cookies) ? cookies : [cookies].filter(Boolean)) as string[],
    email: OPERATOR,
    workspaceId: '',
  };
  const me = await graphql(session, '{ me { workspaces { id } } }');
  operator = { ...session, workspaceId: me.data.me.workspaces[0].id };
  tester = await signIn(harness, TESTER);
}, 60_000);

afterEach(async () => {
  await harness?.close();
});

/**
 * One call, with the fields every call must carry defaulted (SUP-398): a reason,
 * and a `requestId` fresh per call so each is its own decision. A test about a
 * retry passes the id itself.
 */
function inputOf(fields: Record<string, unknown>): Record<string, unknown> {
  return { note: 'Internal tester top-up', requestId: randomUUID(), ...fields };
}

async function grant(input: Record<string, unknown>, as: ConsoleSession = operator) {
  return expectData(as, GRANT, { input: inputOf(input) });
}

/** The raw body, for the cases whose subject is the error. */
async function attempt(input: Record<string, unknown>, as: ConsoleSession = operator) {
  return graphql(as, GRANT, { input: inputOf(input) });
}

describe('an operator crediting an existing account', () => {
  it('moves the balance by exactly the amount, and the account sees it', async () => {
    const result = await grant({ accountEmail: TESTER, amountMicros: '100000000', note: 'Internal tester top-up' });

    expect(result.grantCredit).toMatchObject({
      workspaceId: tester.workspaceId,
      accountEmail: TESTER,
      kind: 'GRANT',
      amountMicros: '100000000',
      balanceMicros: '100000000',
      note: 'Internal tester top-up',
    });

    const balance = await expectData(tester, BALANCE, { workspaceId: tester.workspaceId });
    expect(balance.creditBalance).toMatchObject({ balanceMicros: '100000000', spendable: true });
  });

  it('writes one ledger row the Credits screen renders, naming the operator on the row', async () => {
    const result = await grant({
      workspaceId: tester.workspaceId,
      amountMicros: '25000000',
      note: 'Goodwill after the outage',
    });

    const ledger = await expectData(tester, LEDGER, { workspaceId: tester.workspaceId });
    expect(ledger.creditTransactions.totalCount).toBe(1);
    expect(ledger.creditTransactions.edges[0].node).toMatchObject({
      kind: 'GRANT',
      amountMicros: '25000000',
      reference: OPERATOR_GRANT_REFERENCE,
    });
    expect(ledger.creditTransactions.edges[0].node.description).toContain('Goodwill after the outage');

    const row = await dataSourceOf(harness)
      .getRepository(CreditTransaction)
      .findOneByOrFail({ id: result.grantCredit.creditTransactionId });
    expect(row.grantedByUserId).toBeTruthy();
    expect(row.grantedByUserId).not.toBe(tester.workspaceId);
  });

  it('shows up on the console’s account list, which is where the operator reaches for it', async () => {
    await grant({ accountEmail: TESTER, amountMicros: '7000000' });

    const data = await expectData(operator, SIGN_UPS);
    const row = data.adminSignUps.nodes.find((node: { email: string }) => node.email === TESTER);
    expect(row).toMatchObject({ workspaceId: tester.workspaceId, balanceMicros: '7000000' });
  });
});

describe('who may call it', () => {
  it('refuses a member who is not in auth.adminEmails', async () => {
    const body = await attempt({ accountEmail: TESTER, amountMicros: '100000000' }, tester);

    expect(body.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    expect(await rowCount()).toBe(0);
  });

  it('refuses a caller with no session at all', async () => {
    const body = await attempt({ accountEmail: TESTER, amountMicros: '100000000' }, anonymous(harness));

    expect(body.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
    expect(await rowCount()).toBe(0);
  });
});

describe('what it refuses', () => {
  it('fails cleanly on an account nobody has', async () => {
    const body = await attempt({ accountEmail: 'nobody@example.com', amountMicros: '1000000' });

    expect(body.errors?.[0]?.message).toMatch(/No account for nobody@example.com/);
    expect(await rowCount()).toBe(0);
  });

  it('holds the ceiling on one call', async () => {
    const body = await attempt({ accountEmail: TESTER, amountMicros: String(CEILING + 1) });

    expect(body.errors?.[0]?.message).toMatch(/billing\.maxCreditGrantMicros/);
    expect(await rowCount()).toBe(0);
  });

  it('refuses a debit on a deployment that has not allowed one', async () => {
    const body = await attempt({
      accountEmail: TESTER,
      amountMicros: '-1000000',
      kind: 'ADJUSTMENT',
      note: 'Clawback',
    });

    expect(body.errors?.[0]?.message).toMatch(/allowCreditDebits/);
    expect(await rowCount()).toBe(0);
  });

  it('names the field on an amount past the safe integer range, rather than masking a 500', async () => {
    const body = await attempt({ accountEmail: TESTER, amountMicros: '99999999999999999999' });

    expect(body.errors?.[0]?.extensions?.code).not.toBe('INTERNAL_SERVER_ERROR');
    expect(body.errors?.[0]?.message).toMatch(/amountMicros/);
    expect(await rowCount()).toBe(0);
  });

  it('refuses a negative GRANT, whatever the deployment allows', async () => {
    const body = await attempt({ accountEmail: TESTER, amountMicros: '-1000000', note: 'Clawback' });

    expect(body.errors?.[0]?.message).toMatch(/ADJUSTMENT/);
  });
});

describe('a submission that arrives twice', () => {
  it('replays the first row rather than crediting again', async () => {
    const requestId = randomUUID();
    const first = await grant({ accountEmail: TESTER, amountMicros: '100000000', requestId });
    const again = await grant({ accountEmail: TESTER, amountMicros: '100000000', requestId });

    expect(first.grantCredit.replayed).toBe(false);
    expect(again.grantCredit).toMatchObject({
      replayed: true,
      creditTransactionId: first.grantCredit.creditTransactionId,
      balanceMicros: '100000000',
    });
    expect(await rowCount()).toBe(1);

    const balance = await expectData(tester, BALANCE, { workspaceId: tester.workspaceId });
    expect(balance.creditBalance.balanceMicros).toBe('100000000');
  });

  it('still lets a second deliberate grant through', async () => {
    await grant({ accountEmail: TESTER, amountMicros: '10000000' });
    const second = await grant({ accountEmail: TESTER, amountMicros: '10000000' });

    expect(second.grantCredit).toMatchObject({ replayed: false, balanceMicros: '20000000' });
    expect(await rowCount()).toBe(2);
  });

  it('refuses a call with no requestId at the schema, before any resolver runs', async () => {
    // A missing non-null input field is a validation failure, so this one never
    // reaches a resolver and answers 400 rather than a 200 carrying `errors`.
    const response = await request(harness.app.getHttpServer())
      .post('/graphql')
      .set('Cookie', operator.cookies)
      .send({
        query: GRANT,
        variables: { input: { accountEmail: TESTER, amountMicros: '1000000', note: 'No request id' } },
      })
      .expect(400);

    expect(JSON.stringify(response.body)).toMatch(/requestId/);
    expect(await rowCount()).toBe(0);
  });
});

describe('a requestId aimed at a second account', () => {
  it('is refused, rather than reporting a credit that account never got', async () => {
    // The hand-written path the issue names: credit one person, copy the
    // mutation for the next, change the address, forget the requestId.
    const requestId = randomUUID();
    await grant({ accountEmail: TESTER, amountMicros: '100000000', requestId });
    const body = await attempt({ accountEmail: OPERATOR, amountMicros: '100000000', requestId });

    expect(body.errors?.[0]?.message).toMatch(/another account/);
    expect(await rowCount()).toBe(1);

    // The operator's own balance is untouched, and the tester's is the one grant.
    const balance = await expectData(operator, BALANCE, { workspaceId: operator.workspaceId });
    expect(balance.creditBalance.balanceMicros).toBe('0');
    const theirs = await expectData(tester, BALANCE, { workspaceId: tester.workspaceId });
    expect(theirs.creditBalance.balanceMicros).toBe('100000000');
  });
});

describe('the reason', () => {
  it('is required on a grant, not only on a debit', async () => {
    const body = await attempt({ accountEmail: TESTER, amountMicros: '1000000', note: '   ' });

    expect(body.errors?.[0]?.message).toMatch(/reason|note/i);
    expect(await rowCount()).toBe(0);
  });

  it('reaches the account holder’s Credits screen on the row', async () => {
    await grant({ accountEmail: TESTER, amountMicros: '1000000', note: 'SUP-389: topped up' });

    const ledger = await expectData(tester, LEDGER, { workspaceId: tester.workspaceId });
    expect(ledger.creditTransactions.edges[0].node.description).toBe(
      'Credit granted by an operator · SUP-389: topped up',
    );
  });
});

describe('a deployment that allows debits', () => {
  beforeEach(async () => {
    await harness.close();
    harness = await createHarness({
      env: {
        CR_API_AUTH__BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN,
        CR_API_AUTH__ADMIN_EMAILS: OPERATOR,
        CR_API_BILLING__ALLOW_CREDIT_DEBITS: 'true',
      },
    });
    const claimed = await request(harness.app.getHttpServer())
      .post('/auth/bootstrap')
      .send({ token: BOOTSTRAP_TOKEN })
      .expect(200);
    const cookies = claimed.headers['set-cookie'];
    operator = {
      harness,
      cookies: (Array.isArray(cookies) ? cookies : [cookies].filter(Boolean)) as string[],
      email: OPERATOR,
      workspaceId: '',
    };
    tester = await signIn(harness, TESTER);
  }, 60_000);

  it('corrects a balance down, and cannot push it below zero', async () => {
    await grant({ accountEmail: TESTER, amountMicros: '100000000' });

    const corrected = await grant({
      accountEmail: TESTER,
      amountMicros: '-40000000',
      kind: 'ADJUSTMENT',
      note: 'Duplicate grant on 18 Oct',
    });
    expect(corrected.grantCredit).toMatchObject({ kind: 'ADJUSTMENT', balanceMicros: '60000000' });

    const refused = await attempt({
      accountEmail: TESTER,
      amountMicros: '-60000001',
      kind: 'ADJUSTMENT',
      note: 'More than they hold',
    });
    expect(refused.errors?.[0]).toBeDefined();

    const balance = await expectData(tester, BALANCE, { workspaceId: tester.workspaceId });
    expect(balance.creditBalance.balanceMicros).toBe('60000000');
  });
});

function rowCount(): Promise<number> {
  return dataSourceOf(harness).getRepository(CreditTransaction).count();
}
