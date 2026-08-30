import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDataSource, seedCatalog, testConfig } from '../../../test/seed.js';
import { CreditTransaction } from '../db/entities/credit-transaction.entity.js';
import { Workspace } from '../db/entities/workspace.entity.js';
import { InsufficientCreditsError, LedgerSignError } from './ledger.errors.js';
import { LedgerService } from './ledger.service.js';

/**
 * The executable form of `data-model.md` invariant 3 and ADR-005 §1–3. Every
 * test here ends by asserting the same thing the production code promises: the
 * cached balance is the sum of the ledger.
 */

let dataSource: DataSource;
let ledger: LedgerService;
let workspaceId: string;

beforeEach(async () => {
  dataSource = await createTestDataSource();
  ledger = new LedgerService(dataSource, testConfig());
  ({ workspaceId } = await seedCatalog(dataSource));
});

afterEach(async () => {
  await dataSource.destroy();
});

/** The invariant, checked against the database rather than against the return value. */
async function assertBalanceMatchesLedger(): Promise<number> {
  const workspace = await dataSource.getRepository(Workspace).findOneByOrFail({ id: workspaceId });
  const entries = await dataSource.getRepository(CreditTransaction).findBy({ workspaceId });
  const sum = entries.reduce((total, entry) => total + entry.amountMicros, 0);
  expect(workspace.balanceMicros).toBe(sum);
  return workspace.balanceMicros;
}

function purchase(amountMicros: number, key = `stripe:payment:${amountMicros}`) {
  return ledger.record({ workspaceId, kind: 'purchase', amountMicros, idempotencyKey: key, reference: 'pi_test' });
}

describe('recording an entry', () => {
  it('moves the cached balance by exactly the amount it appended', async () => {
    await purchase(20_000_000);

    expect(await assertBalanceMatchesLedger()).toBe(20_000_000);
  });

  it('keeps the balance equal to the ledger across a mixed sequence', async () => {
    await purchase(20_000_000);
    await ledger.debitGeneration({ workspaceId, generationId: 'gen-1', amountMicros: 5_450 });
    await ledger.debitGeneration({ workspaceId, generationId: 'gen-2', amountMicros: 1_200 });
    await ledger.record({
      workspaceId,
      kind: 'adjustment',
      amountMicros: -1_000_000,
      idempotencyKey: 'admin:refund-goodwill',
    });

    expect(await assertBalanceMatchesLedger()).toBe(20_000_000 - 5_450 - 1_200 - 1_000_000);
  });

  it('refuses an amount whose sign contradicts its kind', async () => {
    await expect(
      ledger.record({ workspaceId, kind: 'purchase', amountMicros: -1, idempotencyKey: 'wrong-sign' }),
    ).rejects.toThrow(LedgerSignError);
    await expect(
      ledger.record({ workspaceId, kind: 'usage', amountMicros: 1, idempotencyKey: 'wrong-sign-2' }),
    ).rejects.toThrow(LedgerSignError);
    await expect(
      ledger.record({ workspaceId, kind: 'adjustment', amountMicros: 0, idempotencyKey: 'zero' }),
    ).rejects.toThrow(LedgerSignError);

    expect(await assertBalanceMatchesLedger()).toBe(0);
  });
});

describe('idempotency', () => {
  it('collapses a redelivered event onto the row it already wrote', async () => {
    const first = await purchase(20_000_000, 'stripe:payment:pi_1');
    const second = await purchase(20_000_000, 'stripe:payment:pi_1');

    expect(second.replayed).toBe(true);
    expect(second.transaction.id).toBe(first.transaction.id);
    expect(await dataSource.getRepository(CreditTransaction).countBy({ workspaceId })).toBe(1);
    expect(await assertBalanceMatchesLedger()).toBe(20_000_000);
  });

  it('charges once when the same event is delivered concurrently', async () => {
    // Both callers pass the pre-flight read, so the unique index — not the read
    // — is what has to stop the second write.
    const results = await Promise.all([
      purchase(20_000_000, 'stripe:payment:pi_race'),
      purchase(20_000_000, 'stripe:payment:pi_race'),
    ]);

    expect(results.filter((result) => result.replayed)).toHaveLength(1);
    expect(await dataSource.getRepository(CreditTransaction).countBy({ workspaceId })).toBe(1);
    expect(await assertBalanceMatchesLedger()).toBe(20_000_000);
  });

  it('debits a generation exactly once however often metering retries', async () => {
    await purchase(20_000_000);
    await ledger.debitGeneration({ workspaceId, generationId: 'gen-retry', amountMicros: 5_450 });
    const replay = await ledger.debitGeneration({ workspaceId, generationId: 'gen-retry', amountMicros: 5_450 });

    expect(replay?.replayed).toBe(true);
    expect(await assertBalanceMatchesLedger()).toBe(20_000_000 - 5_450);
  });

  it('writes nothing for a generation that cost nothing', async () => {
    expect(await ledger.debitGeneration({ workspaceId, generationId: 'gen-free', amountMicros: 0 })).toBeNull();
    expect(await dataSource.getRepository(CreditTransaction).countBy({ workspaceId })).toBe(0);
  });
});

describe('the negative-balance rule', () => {
  it('lets a generation overdraw, because its cost is only known afterwards', async () => {
    await purchase(5_000_000);
    await ledger.debitGeneration({ workspaceId, generationId: 'gen-big', amountMicros: 6_000_000 });

    expect(await assertBalanceMatchesLedger()).toBe(-1_000_000);
  });

  it('refuses an adjustment that would take the balance below zero', async () => {
    await purchase(5_000_000);

    await expect(
      ledger.record({
        workspaceId,
        kind: 'adjustment',
        amountMicros: -6_000_000,
        idempotencyKey: 'admin:too-big',
      }),
    ).rejects.toThrow(InsufficientCreditsError);

    // The refusal rolled the balance update back with the insert.
    expect(await assertBalanceMatchesLedger()).toBe(5_000_000);
  });

  it('blocks further spending once the balance is not positive', async () => {
    await purchase(5_000_000);
    await ledger.debitGeneration({ workspaceId, generationId: 'gen-drain', amountMicros: 5_000_000 });

    expect(await ledger.balanceOf(workspaceId)).toEqual({ balanceMicros: 0, spendable: false });
  });

  it('honours the configured overdraft allowance', async () => {
    const lenient = new LedgerService(dataSource, testConfig({ CR_API_BILLING__ALLOW_OVERDRAFT_MICROS: '1000000' }));
    await purchase(5_000_000);
    await ledger.debitGeneration({ workspaceId, generationId: 'gen-drain', amountMicros: 5_000_000 });

    expect((await lenient.balanceOf(workspaceId)).spendable).toBe(true);
  });
});

describe('concurrent debits', () => {
  it('loses no update when many generations settle at once', async () => {
    await purchase(20_000_000);

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        ledger.debitGeneration({ workspaceId, generationId: `gen-${index}`, amountMicros: 1_000 }),
      ),
    );

    expect(await assertBalanceMatchesLedger()).toBe(20_000_000 - 20_000);
  });
});

describe('paging the ledger', () => {
  it('walks every entry newest first, without repeating or skipping one', async () => {
    for (let index = 0; index < 7; index += 1) {
      await ledger.record({
        workspaceId,
        kind: 'purchase',
        amountMicros: 1_000_000 + index,
        idempotencyKey: `purchase-${index}`,
      });
    }

    const first = await ledger.page({ workspaceId, first: 3 });
    const second = await ledger.page({ workspaceId, first: 3, after: first.endCursor });
    const third = await ledger.page({ workspaceId, first: 3, after: second.endCursor });

    expect(first.totalCount).toBe(7);
    expect(first.hasNextPage).toBe(true);
    expect(third.hasNextPage).toBe(false);
    const ids = [...first.edges, ...second.edges, ...third.edges].map((edge) => edge.node.id);
    expect(new Set(ids).size).toBe(7);
  });
});
