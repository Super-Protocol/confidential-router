import { randomUUID } from 'node:crypto';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDataSource, seedCatalog, testConfig } from '../../../test/seed.js';
import { CreditTransaction } from '../db/entities/credit-transaction.entity.js';
import { Workspace } from '../db/entities/workspace.entity.js';
import { WorkspaceMember } from '../db/entities/workspace-member.entity.js';
import { CreditGrantService, OPERATOR_GRANT_REFERENCE } from './credit-grant.service.js';
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
    const result = await grants.grant({
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
    const result = await grants.grant({
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
    await grants.grant({ workspaceId, kind: 'grant', amountMicros: 10_000_000, operator: OPERATOR });
    await grants.grant({ workspaceId, kind: 'grant', amountMicros: 7_000_000, operator: OPERATOR });

    expect(await balanceOf()).toBe(17_000_000);
  });

  it('keeps a repeated grant as a second entry — an operator asking twice means twice', async () => {
    const first = await grants.grant({ workspaceId, kind: 'grant', amountMicros: 1_000_000, operator: OPERATOR });
    const second = await grants.grant({ workspaceId, kind: 'grant', amountMicros: 1_000_000, operator: OPERATOR });

    expect(second.creditTransactionId).not.toBe(first.creditTransactionId);
    expect(await balanceOf()).toBe(2_000_000);
  });
});

describe('naming the account', () => {
  it('credits the workspace the address owns', async () => {
    await account(TESTER);

    const result = await grants.grant({
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

    const result = await grants.grant({
      accountEmail: ' Tester@Example.COM ',
      kind: 'grant',
      amountMicros: 1_000_000,
      operator: OPERATOR,
    });

    expect(result.workspaceId).toBe(workspaceId);
  });

  it('fails cleanly on an account that does not exist', async () => {
    await expect(
      grants.grant({ accountEmail: 'nobody@example.com', kind: 'grant', amountMicros: 1_000_000, operator: OPERATOR }),
    ).rejects.toThrow(NotFoundException);

    expect(await balanceOf()).toBe(0);
  });

  it('fails cleanly on a workspace that does not exist', async () => {
    await expect(
      grants.grant({ workspaceId: randomUUID(), kind: 'grant', amountMicros: 1_000_000, operator: OPERATOR }),
    ).rejects.toThrow(NotFoundException);
  });

  it('says so when the account owns no workspace', async () => {
    await account('homeless@example.com', '');

    await expect(
      grants.grant({
        accountEmail: 'homeless@example.com',
        kind: 'grant',
        amountMicros: 1_000_000,
        operator: OPERATOR,
      }),
    ).rejects.toThrow(/owns no workspace/);
  });

  it('refuses a call that names both, or neither', async () => {
    await account(TESTER);

    await expect(
      grants.grant({ workspaceId, accountEmail: TESTER, kind: 'grant', amountMicros: 1, operator: OPERATOR }),
    ).rejects.toThrow(BadRequestException);
    await expect(grants.grant({ kind: 'grant', amountMicros: 1, operator: OPERATOR })).rejects.toThrow(
      BadRequestException,
    );
  });
});

describe('the bound on one call', () => {
  it('allows exactly the ceiling', async () => {
    await grants.grant({ workspaceId, kind: 'grant', amountMicros: CEILING, operator: OPERATOR });

    expect(await balanceOf()).toBe(CEILING);
  });

  it('refuses one micro-USD over it, and writes nothing', async () => {
    await expect(
      grants.grant({ workspaceId, kind: 'grant', amountMicros: CEILING + 1, operator: OPERATOR }),
    ).rejects.toThrow(/billing.maxCreditGrantMicros/);

    expect(await balanceOf()).toBe(0);
    expect(await dataSource.getRepository(CreditTransaction).count()).toBe(0);
  });

  it('holds at whatever the deployment configured', async () => {
    await build({ CR_API_BILLING__MAX_CREDIT_GRANT_MICROS: '5000000' });

    await expect(
      grants.grant({ workspaceId, kind: 'grant', amountMicros: 5_000_001, operator: OPERATOR }),
    ).rejects.toThrow(/billing.maxCreditGrantMicros/);
    await grants.grant({ workspaceId, kind: 'grant', amountMicros: 5_000_000, operator: OPERATOR });

    expect(await balanceOf()).toBe(5_000_000);
  });

  it('refuses a zero, which would be a ledger row that says nothing', async () => {
    await expect(grants.grant({ workspaceId, kind: 'grant', amountMicros: 0, operator: OPERATOR })).rejects.toThrow(
      BadRequestException,
    );
  });
});

describe('taking credit away', () => {
  beforeEach(async () => {
    await build({ CR_API_BILLING__ALLOW_CREDIT_DEBITS: 'true' });
    await grants.grant({ workspaceId, kind: 'grant', amountMicros: 100_000_000, operator: OPERATOR });
  });

  it('is off unless the deployment turned it on', async () => {
    await build();

    await expect(
      grants.grant({ workspaceId, kind: 'adjustment', amountMicros: -1_000_000, note: 'Clawback', operator: OPERATOR }),
    ).rejects.toThrow(/allowCreditDebits/);

    expect(await balanceOf()).toBe(100_000_000);
  });

  it('is an adjustment, never a grant', async () => {
    await expect(
      grants.grant({ workspaceId, kind: 'grant', amountMicros: -1_000_000, note: 'Clawback', operator: OPERATOR }),
    ).rejects.toThrow(/ADJUSTMENT/);
  });

  it('needs a note saying why', async () => {
    await expect(
      grants.grant({ workspaceId, kind: 'adjustment', amountMicros: -1_000_000, note: '   ', operator: OPERATOR }),
    ).rejects.toThrow(/note/);
  });

  it('removes exactly the amount, on an audited row', async () => {
    const result = await grants.grant({
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
      grants.grant({
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
    const result = await grants.grant({
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
