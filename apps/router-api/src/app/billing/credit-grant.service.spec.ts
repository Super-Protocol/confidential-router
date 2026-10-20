import { randomUUID } from 'node:crypto';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDataSource, seedCatalog, testConfig } from '../../../test/seed.js';
import { CreditTransaction } from '../db/entities/credit-transaction.entity.js';
import { Workspace } from '../db/entities/workspace.entity.js';
import { WorkspaceMember } from '../db/entities/workspace-member.entity.js';
import {
  type CreditGrantRequest,
  type CreditGrantResult,
  CreditGrantService,
  OPERATOR_GRANT_REFERENCE,
} from './credit-grant.service.js';
import { LedgerService } from './ledger.service.js';

/**
 * Putting credit on an account that already exists (SUP-406).
 *
 * The ledger's own guarantees are `ledger.service.spec.ts`'s subject; what is
 * under test here is the operator-facing layer — the bound, the sign rules, the
 * two ways of naming a target, and that the row says who did it and why. Every
 * success case ends on the same assertion the ledger spec does: the cached
 * balance is the sum of the ledger.
 */

const OPERATOR = { id: 'operator-1', email: 'ops@superprotocol.com' };
const TESTER = 'tester@example.com';
/** The schema default, $10 000. */
const CEILING = 10_000_000_000;

let dataSource: DataSource;
let grants: CreditGrantService;
let workspaceId: string;

async function build(overrides: Record<string, string> = {}): Promise<void> {
  const config = testConfig(overrides);
  grants = new CreditGrantService(dataSource, config, new LedgerService(dataSource, config));
}

beforeEach(async () => {
  dataSource = await createTestDataSource();
  // Better Auth owns `user` and creates it with its own migration, which a unit
  // test does not run. The columns `User` maps are all the lookup here needs.
  await dataSource.query(
    'CREATE TABLE "user" ("id" varchar PRIMARY KEY, "email" varchar NOT NULL, "name" varchar NOT NULL, "image" varchar, "createdAt" date NOT NULL)',
  );
  ({ workspaceId } = await seedCatalog(dataSource));
  await build();
});

afterEach(async () => {
  await dataSource.destroy();
});

/** An account that owns `workspaceId`, the way a first login provisions one. */
async function account(email: string, owns = workspaceId): Promise<string> {
  const id = randomUUID();
  await dataSource.query('INSERT INTO "user" ("id", "email", "name", "createdAt") VALUES (?, ?, ?, ?)', [
    id,
    email,
    '',
    new Date('2026-10-01T00:00:00Z').toISOString(),
  ]);
  if (owns) {
    await dataSource
      .getRepository(WorkspaceMember)
      .insert({ workspaceId: owns, userId: id, role: 'owner', createdAt: new Date('2026-10-01T00:00:00Z') });
  }
  return id;
}

/**
 * One call, with the two fields every call must now carry defaulted (SUP-398).
 *
 * `requestId` is fresh per call, so a test that means two decisions gets two
 * rows; a test about a *retry* says so by passing the same id itself, which is
 * the distinction the service exists to draw.
 */
async function grant(
  input: Omit<CreditGrantRequest, 'note' | 'requestId' | 'operator'> &
    Partial<Pick<CreditGrantRequest, 'note' | 'requestId' | 'operator'>>,
): Promise<CreditGrantResult> {
  return grants.grant({
    note: 'Internal tester top-up',
    requestId: randomUUID(),
    operator: OPERATOR,
    ...input,
  });
}

async function balanceOf(id = workspaceId): Promise<number> {
  const workspace = await dataSource.getRepository(Workspace).findOneByOrFail({ id });
  const entries = await dataSource.getRepository(CreditTransaction).findBy({ workspaceId: id });
  const sum = entries.reduce((total, entry) => total + entry.amountMicros, 0);
  // The invariant, on every path through this service.
  expect(workspace.balanceMicros).toBe(sum);
  return workspace.balanceMicros;
}

describe('granting credit to an existing account', () => {
  it('moves the balance by exactly the amount granted', async () => {
    const result = await grant({
      workspaceId,
      kind: 'grant',
      amountMicros: 100_000_000,
      note: 'Internal tester top-up',
      operator: OPERATOR,
    });

    expect(result.amountMicros).toBe(100_000_000);
    expect(result.balanceMicros).toBe(100_000_000);
    expect(await balanceOf()).toBe(100_000_000);
  });

  it('records the operator, the kind, the amount and the note on the ledger row', async () => {
    const result = await grant({
      workspaceId,
      kind: 'grant',
      amountMicros: 25_000_000,
      note: 'Goodwill after the 14 Oct outage',
      operator: OPERATOR,
    });

    const row = await dataSource.getRepository(CreditTransaction).findOneByOrFail({ id: result.creditTransactionId });
    expect(row).toMatchObject({
      workspaceId,
      kind: 'grant',
      amountMicros: 25_000_000,
      reference: OPERATOR_GRANT_REFERENCE,
      grantedByUserId: OPERATOR.id,
    });
    expect(row.description).toContain('Goodwill after the 14 Oct outage');
  });

  it('leaves no operator on an entry nobody granted by hand', async () => {
    const ledger = new LedgerService(dataSource, testConfig());
    const entry = await ledger.record({
      workspaceId,
      kind: 'purchase',
      amountMicros: 5_000_000,
      idempotencyKey: 'stripe:pi_1',
    });

    expect(entry.transaction.grantedByUserId).toBeNull();
  });

  it('adds to a balance rather than replacing it, and stacks', async () => {
    await grant({ workspaceId, kind: 'grant', amountMicros: 10_000_000, operator: OPERATOR });
    await grant({ workspaceId, kind: 'grant', amountMicros: 7_000_000, operator: OPERATOR });

    expect(await balanceOf()).toBe(17_000_000);
  });
});

/**
 * The same decision sent twice against a second decision (SUP-398).
 *
 * The failure this closes is ordinary: the mutation writes the row, the proxy
 * times out at 504, the dialog reports a failure over a balance that already
 * moved, and the operator presses the button again. Both calls carry the
 * `requestId` the dialog minted when it opened, so the second one replays.
 */
describe('a submission that arrives twice', () => {
  it('writes one row, and says it replayed', async () => {
    const requestId = 'ff2f1e2a-0c4d-4f18-9a2b-7c6d5e4f3a21';
    const first = await grant({ workspaceId, kind: 'grant', amountMicros: 1_000_000, requestId });
    const second = await grant({ workspaceId, kind: 'grant', amountMicros: 1_000_000, requestId });

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.creditTransactionId).toBe(first.creditTransactionId);
    expect(second.balanceMicros).toBe(1_000_000);
    expect(await balanceOf()).toBe(1_000_000);
    expect(await dataSource.getRepository(CreditTransaction).count()).toBe(1);
  });

  it('shows what stands, not what the retry asked for', async () => {
    const requestId = 'retry-with-an-edit';
    await grant({ workspaceId, kind: 'grant', amountMicros: 1_000_000, requestId, note: 'As agreed' });
    const retried = await grant({
      workspaceId,
      kind: 'grant',
      amountMicros: 9_000_000,
      requestId,
      note: 'Actually nine',
    });

    expect(retried).toMatchObject({ replayed: true, amountMicros: 1_000_000, note: 'As agreed' });
    expect(await balanceOf()).toBe(1_000_000);
  });

  it('lets a second deliberate grant through, because it carries a second requestId', async () => {
    const first = await grant({ workspaceId, kind: 'grant', amountMicros: 1_000_000, requestId: 'decision-1' });
    const second = await grant({ workspaceId, kind: 'grant', amountMicros: 1_000_000, requestId: 'decision-2' });

    expect(second.creditTransactionId).not.toBe(first.creditTransactionId);
    expect(second.replayed).toBe(false);
    expect(await balanceOf()).toBe(2_000_000);
  });

  it('is scoped to the operator, so two of them cannot collide on one id', async () => {
    const requestId = '1';
    await grant({ workspaceId, kind: 'grant', amountMicros: 1_000_000, requestId });
    const other = await grant({
      workspaceId,
      kind: 'grant',
      amountMicros: 1_000_000,
      requestId,
      operator: { id: 'operator-2', email: 'other@superprotocol.com' },
    });

    expect(other.replayed).toBe(false);
    expect(await balanceOf()).toBe(2_000_000);
  });

  it('refuses the same requestId aimed at a second account, rather than answering about it', async () => {
    const other = await seedCatalog(dataSource);
    const requestId = 'copied-the-mutation-and-changed-the-email';
    await grant({ workspaceId, kind: 'grant', amountMicros: 100_000_000, requestId, note: 'Top up A' });

    // The path the issue names for the first production use: credit one person,
    // copy the mutation for the next, change the address, forget the requestId.
    await expect(
      grant({ workspaceId: other.workspaceId, kind: 'grant', amountMicros: 100_000_000, requestId, note: 'Top up B' }),
    ).rejects.toThrow(/another account/);

    // Neither side moved: A keeps its one entry, B was never credited.
    expect(await balanceOf()).toBe(100_000_000);
    expect(await balanceOf(other.workspaceId)).toBe(0);
    expect(await dataSource.getRepository(CreditTransaction).count()).toBe(1);
  });

  it('answers with the workspace on the row, so a payload is never two accounts', async () => {
    await account(TESTER);
    const requestId = 'one-decision';
    const first = await grant({ accountEmail: TESTER, kind: 'grant', amountMicros: 1_000_000, requestId });
    const again = await grant({ workspaceId, kind: 'grant', amountMicros: 1_000_000, requestId });

    // Both name the same workspace — one by address, one by id — so this is the
    // same decision, and the reply is the stored row throughout. With the
    // refusal above in place the two can no longer differ, which is the point:
    // this pins the payload to one source so that stays true if the refusal is
    // ever softened.
    expect(again).toMatchObject({ replayed: true, workspaceId: first.workspaceId });
    expect(again.creditTransactionId).toBe(first.creditTransactionId);
  });

  it('refuses a requestId that would overflow the ledger’s key, on every driver', async () => {
    await expect(
      grant({
        workspaceId,
        kind: 'grant',
        amountMicros: 1_000_000,
        requestId: 'x'.repeat(64),
        operator: { id: 'o'.repeat(64), email: OPERATOR.email },
      }),
    ).rejects.toThrow(/128-character ledger key/);

    expect(await dataSource.getRepository(CreditTransaction).count()).toBe(0);
  });

  it('refuses a blank requestId rather than inventing one', async () => {
    await expect(grant({ workspaceId, kind: 'grant', amountMicros: 1_000_000, requestId: '  ' })).rejects.toThrow(
      /requestId/,
    );

    expect(await balanceOf()).toBe(0);
  });
});

describe('naming the account', () => {
  it('credits the workspace the address owns', async () => {
    await account(TESTER);

    const result = await grant({
      accountEmail: TESTER,
      kind: 'grant',
      amountMicros: 50_000_000,
      operator: OPERATOR,
    });

    expect(result).toMatchObject({ workspaceId, accountEmail: TESTER });
    expect(await balanceOf()).toBe(50_000_000);
  });

  it('matches the address whatever its case', async () => {
    await account(TESTER);

    const result = await grant({
      accountEmail: ' Tester@Example.COM ',
      kind: 'grant',
      amountMicros: 1_000_000,
      operator: OPERATOR,
    });

    expect(result.workspaceId).toBe(workspaceId);
  });

  it('refuses an address two accounts share but for its case, rather than picking one', async () => {
    await account(TESTER);
    await account('Tester@example.com', '');

    await expect(
      grant({ accountEmail: TESTER, kind: 'grant', amountMicros: 1_000_000, operator: OPERATOR }),
    ).rejects.toThrow(/differ only in the case/);

    expect(await balanceOf()).toBe(0);
  });

  it('fails cleanly on an account that does not exist', async () => {
    await expect(
      grant({ accountEmail: 'nobody@example.com', kind: 'grant', amountMicros: 1_000_000, operator: OPERATOR }),
    ).rejects.toThrow(NotFoundException);

    expect(await balanceOf()).toBe(0);
  });

  it('fails cleanly on a workspace that does not exist', async () => {
    await expect(
      grant({ workspaceId: randomUUID(), kind: 'grant', amountMicros: 1_000_000, operator: OPERATOR }),
    ).rejects.toThrow(NotFoundException);
  });

  it('says so when the account owns no workspace', async () => {
    await account('homeless@example.com', '');

    await expect(
      grant({
        accountEmail: 'homeless@example.com',
        kind: 'grant',
        amountMicros: 1_000_000,
        operator: OPERATOR,
      }),
    ).rejects.toThrow(/owns no workspace/);
  });

  it('refuses a call that names both, or neither, and says which', async () => {
    await account(TESTER);

    await expect(
      grant({ workspaceId, accountEmail: TESTER, kind: 'grant', amountMicros: 1, operator: OPERATOR }),
    ).rejects.toThrow(/not both/);
    // Naming neither is the opposite mistake and used to be told it had named both.
    await expect(grant({ kind: 'grant', amountMicros: 1, operator: OPERATOR })).rejects.toThrow(
      /Name the account to credit, by either/,
    );
  });

  it('never answers a replay with a workspace the stored row did not credit', async () => {
    const other = (await seedCatalog(dataSource)).workspaceId;
    const requestId = randomUUID();
    await grant({ workspaceId, kind: 'grant', amountMicros: 1_000_000, operator: OPERATOR, requestId });

    // The same submission pointed at a different workspace is refused outright
    // (see the cross-account case above), so there is no path on which the
    // reported workspace and the reported balance can come from two rows.
    await expect(
      grant({ workspaceId: other, kind: 'grant', amountMicros: 1_000_000, operator: OPERATOR, requestId }),
    ).rejects.toThrow(/another account/);

    expect(await balanceOf()).toBe(1_000_000);
    expect(await balanceOf(other)).toBe(0);
  });
});

describe('the bound on one call', () => {
  it('allows exactly the ceiling', async () => {
    await grant({ workspaceId, kind: 'grant', amountMicros: CEILING, operator: OPERATOR });

    expect(await balanceOf()).toBe(CEILING);
  });

  it('refuses one micro-USD over it, and writes nothing', async () => {
    await expect(grant({ workspaceId, kind: 'grant', amountMicros: CEILING + 1, operator: OPERATOR })).rejects.toThrow(
      /billing.maxCreditGrantMicros/,
    );

    expect(await balanceOf()).toBe(0);
    expect(await dataSource.getRepository(CreditTransaction).count()).toBe(0);
  });

  it('holds at whatever the deployment configured', async () => {
    await build({ CR_API_BILLING__MAX_CREDIT_GRANT_MICROS: '5000000' });

    await expect(grant({ workspaceId, kind: 'grant', amountMicros: 5_000_001, operator: OPERATOR })).rejects.toThrow(
      /billing.maxCreditGrantMicros/,
    );
    await grant({ workspaceId, kind: 'grant', amountMicros: 5_000_000, operator: OPERATOR });

    expect(await balanceOf()).toBe(5_000_000);
  });

  it('refuses a zero, which would be a ledger row that says nothing', async () => {
    await expect(grant({ workspaceId, kind: 'grant', amountMicros: 0 })).rejects.toThrow(BadRequestException);
  });
});

/**
 * Why, on every call (SUP-398).
 *
 * `grantedByUserId` says who moved the credit and `reference` says it was by
 * hand; `description` is the only field that says why, and an operator entry is
 * the one ledger row with no outside event to explain it. SUP-389's $100 was
 * unexplainable as well as unreclaimable.
 */
describe('the reason', () => {
  it('is required on a grant, not only on a debit', async () => {
    await expect(grant({ workspaceId, kind: 'grant', amountMicros: 1_000_000, note: '' })).rejects.toThrow(/reason/);

    expect(await balanceOf()).toBe(0);
    expect(await dataSource.getRepository(CreditTransaction).count()).toBe(0);
  });

  it('is required on an upward correction too', async () => {
    await expect(grant({ workspaceId, kind: 'adjustment', amountMicros: 1_000_000, note: '  ' })).rejects.toThrow(
      /reason/,
    );
  });

  it('lands on the row trimmed, and comes back as written', async () => {
    const result = await grant({
      workspaceId,
      kind: 'grant',
      amountMicros: 1_000_000,
      note: '  SUP-389: topped up after the verification grant  ',
    });

    const row = await dataSource.getRepository(CreditTransaction).findOneByOrFail({ id: result.creditTransactionId });
    expect(row.description).toBe('Credit granted by an operator · SUP-389: topped up after the verification grant');
    expect(result.note).toBe('SUP-389: topped up after the verification grant');
  });
});

describe('taking credit away', () => {
  beforeEach(async () => {
    await build({ CR_API_BILLING__ALLOW_CREDIT_DEBITS: 'true' });
    await grant({ workspaceId, kind: 'grant', amountMicros: 100_000_000, operator: OPERATOR });
  });

  it('is off unless the deployment turned it on', async () => {
    await build();

    await expect(
      grant({ workspaceId, kind: 'adjustment', amountMicros: -1_000_000, note: 'Clawback', operator: OPERATOR }),
    ).rejects.toThrow(/allowCreditDebits/);

    expect(await balanceOf()).toBe(100_000_000);
  });

  it('is an adjustment, never a grant', async () => {
    await expect(
      grant({ workspaceId, kind: 'grant', amountMicros: -1_000_000, note: 'Clawback', operator: OPERATOR }),
    ).rejects.toThrow(/ADJUSTMENT/);
  });

  it('needs a reason saying why', async () => {
    await expect(grant({ workspaceId, kind: 'adjustment', amountMicros: -1_000_000, note: '   ' })).rejects.toThrow(
      /reason/,
    );
  });

  it('removes exactly the amount, on an audited row', async () => {
    const result = await grant({
      workspaceId,
      kind: 'adjustment',
      amountMicros: -40_000_000,
      note: 'Duplicate grant on 18 Oct',
      operator: OPERATOR,
    });

    const row = await dataSource.getRepository(CreditTransaction).findOneByOrFail({ id: result.creditTransactionId });
    expect(row).toMatchObject({ kind: 'adjustment', amountMicros: -40_000_000, grantedByUserId: OPERATOR.id });
    expect(await balanceOf()).toBe(60_000_000);
  });

  it('cannot take a balance below zero, so no call can quietly clear one', async () => {
    await expect(
      grant({
        workspaceId,
        kind: 'adjustment',
        amountMicros: -100_000_001,
        note: 'More than they hold',
        operator: OPERATOR,
      }),
    ).rejects.toThrow();

    expect(await balanceOf()).toBe(100_000_000);
  });

  it('corrects upward as an adjustment too', async () => {
    const result = await grant({
      workspaceId,
      kind: 'adjustment',
      amountMicros: 5_000_000,
      note: 'Short by $5',
      operator: OPERATOR,
    });

    expect(result.kind).toBe('adjustment');
    expect(await balanceOf()).toBe(105_000_000);
  });
});
