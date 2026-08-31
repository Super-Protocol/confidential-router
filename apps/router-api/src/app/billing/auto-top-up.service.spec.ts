import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDataSource, seedCatalog, testConfig } from '../../../test/seed.js';
import { Workspace } from '../db/entities/workspace.entity.js';
import { AutoTopUpService } from './auto-top-up.service.js';
import { BillingService } from './billing.service.js';
import { LedgerService } from './ledger.service.js';
import type { LedgerEvent, PaymentProvider, SavedCharge } from './payment-provider.js';

/** A provider that records what it was asked to charge and never leaves the process. */
class RecordingProvider implements PaymentProvider {
  readonly name = 'recording';
  readonly supportsSavedPaymentMethods = true;
  readonly charges: SavedCharge[] = [];
  outcome: 'settle' | 'pending' | 'throw' = 'settle';

  async createCheckout(): Promise<never> {
    throw new Error('not used');
  }

  async handleWebhook(): Promise<LedgerEvent[]> {
    return [];
  }

  async chargeSaved(charge: SavedCharge): Promise<LedgerEvent | null> {
    this.charges.push(charge);
    if (this.outcome === 'throw') {
      throw new Error('Your card was declined.');
    }
    if (this.outcome === 'pending') {
      return null;
    }
    return {
      workspaceId: charge.workspaceId,
      kind: 'auto_topup',
      amountMicros: charge.amountMicros,
      reference: `pi_${charge.idempotencyKey}`,
      idempotencyKey: charge.idempotencyKey,
      customerRef: charge.customerRef,
    };
  }
}

const config = testConfig();

let dataSource: DataSource;
let provider: RecordingProvider;
let ledger: LedgerService;
let autoTopUp: AutoTopUpService;
let workspaceId: string;

beforeEach(async () => {
  dataSource = await createTestDataSource();
  provider = new RecordingProvider();
  ledger = new LedgerService(dataSource, config);
  autoTopUp = new AutoTopUpService(provider, new BillingService(dataSource, config, provider, ledger));
  ({ workspaceId } = await seedCatalog(dataSource, 1_000_000));
});

afterEach(async () => {
  await dataSource.destroy();
});

type AutoTopUpColumns = Pick<
  Workspace,
  'autoTopUpEnabled' | 'autoTopUpThresholdMicros' | 'autoTopUpAmountMicros' | 'stripeCustomerId'
>;

async function enableAutoTopUp(overrides: Partial<AutoTopUpColumns> = {}): Promise<void> {
  await dataSource.getRepository(Workspace).update(
    { id: workspaceId },
    {
      autoTopUpEnabled: true,
      autoTopUpThresholdMicros: 5_000_000,
      autoTopUpAmountMicros: 20_000_000,
      stripeCustomerId: 'cus_test_1',
      ...overrides,
    },
  );
}

describe('deciding whether to top up', () => {
  it('charges when the balance has fallen under the threshold', async () => {
    await enableAutoTopUp();

    expect(await autoTopUp.consider(workspaceId)).toEqual({ charged: true, amountMicros: 20_000_000 });
    const workspace = await dataSource.getRepository(Workspace).findOneByOrFail({ id: workspaceId });
    expect(workspace.balanceMicros).toBe(21_000_000);
  });

  it('does nothing while the balance is still above the threshold', async () => {
    await enableAutoTopUp({ autoTopUpThresholdMicros: 100_000 });

    expect(await autoTopUp.consider(workspaceId)).toEqual({ charged: false, reason: 'above-threshold' });
    expect(provider.charges).toHaveLength(0);
  });

  it('does nothing when the workspace has not turned it on', async () => {
    expect(await autoTopUp.consider(workspaceId)).toEqual({ charged: false, reason: 'disabled' });
  });

  it('does nothing when no checkout has ever saved a card', async () => {
    await enableAutoTopUp({ stripeCustomerId: null });

    expect(await autoTopUp.consider(workspaceId)).toEqual({ charged: false, reason: 'no-payment-method' });
    expect(provider.charges).toHaveLength(0);
  });
});

describe('the cooldown', () => {
  it('charges once for one dip below the threshold, however many debits follow', async () => {
    await enableAutoTopUp();

    const outcomes = await Promise.all([
      autoTopUp.consider(workspaceId),
      autoTopUp.consider(workspaceId),
      autoTopUp.consider(workspaceId),
    ]);

    expect(outcomes.filter((outcome) => outcome.charged)).toHaveLength(1);
    expect(provider.charges).toHaveLength(1);
  });

  it('does not retry a declined card on the very next request', async () => {
    await enableAutoTopUp();
    provider.outcome = 'throw';

    expect(await autoTopUp.consider(workspaceId)).toEqual({ charged: false, reason: 'failed' });
    expect(await autoTopUp.consider(workspaceId)).toEqual({ charged: false, reason: 'cooling-down' });
    expect(provider.charges).toHaveLength(1);
  });

  it('tries again once the cooldown has passed', async () => {
    await enableAutoTopUp();
    provider.outcome = 'throw';
    const start = new Date('2026-08-30T12:00:00Z');

    await autoTopUp.consider(workspaceId, start);
    await autoTopUp.consider(workspaceId, new Date(start.getTime() + 61 * 60 * 1000));

    expect(provider.charges).toHaveLength(2);
  });

  it('gives each attempt its own idempotency key, so two dips are two credits', async () => {
    await enableAutoTopUp();
    // Declined both times, so the balance stays under the threshold and the
    // second attempt is a genuinely new dip rather than a replay of the first.
    provider.outcome = 'throw';
    const start = new Date('2026-08-30T12:00:00Z');

    await autoTopUp.consider(workspaceId, start);
    await autoTopUp.consider(workspaceId, new Date(start.getTime() + 61 * 60 * 1000));

    expect(new Set(provider.charges.map((charge) => charge.idempotencyKey)).size).toBe(2);
  });
});

describe('an unsettled charge', () => {
  it('credits nothing yet and leaves the webhook to finish it', async () => {
    await enableAutoTopUp();
    provider.outcome = 'pending';

    expect(await autoTopUp.consider(workspaceId)).toEqual({ charged: false, reason: 'no-payment-method' });
    const workspace = await dataSource.getRepository(Workspace).findOneByOrFail({ id: workspaceId });
    expect(workspace.balanceMicros).toBe(1_000_000);
  });

  it('credits the same key the webhook would use, so the two cannot both count', async () => {
    await enableAutoTopUp();
    await autoTopUp.consider(workspaceId);

    // The webhook arrives afterwards carrying the same charge.
    const billing = new BillingService(dataSource, config, provider, ledger);
    await billing.apply([
      {
        workspaceId,
        kind: 'auto_topup',
        amountMicros: 20_000_000,
        reference: 'pi_late',
        idempotencyKey: provider.charges[0].idempotencyKey,
      },
    ]);

    const workspace = await dataSource.getRepository(Workspace).findOneByOrFail({ id: workspaceId });
    expect(workspace.balanceMicros).toBe(21_000_000);
  });
});

describe('when the provider cannot charge a saved card', () => {
  it('never tries', async () => {
    const incapable = { ...provider, supportsSavedPaymentMethods: false } as unknown as PaymentProvider;
    const service = new AutoTopUpService(incapable, new BillingService(dataSource, config, incapable, ledger));
    await enableAutoTopUp();

    expect(await service.consider(workspaceId)).toEqual({ charged: false, reason: 'disabled' });
  });
});
