import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDataSource, seedCatalog, testConfig } from '../../../test/seed.js';
import { LedgerService } from '../billing/ledger.service.js';
import { CreditTransaction } from '../db/entities/credit-transaction.entity.js';
import { Workspace } from '../db/entities/workspace.entity.js';
import { InvitesService } from './invites.service.js';
import { NO_SIGN_UP_INVITE } from './sign-up-invite.js';
import { SignUpGrantService } from './signup-grant.service.js';

/**
 * The sign-up grant (SUP-249), executed against a real ledger: every outcome is
 * asserted together with the database it leaves behind.
 */

const TWENTY_USD = 20_000_000;

let dataSource: DataSource;
let workspaceId: string;

beforeEach(async () => {
  dataSource = await createTestDataSource();
  ({ workspaceId } = await seedCatalog(dataSource));
});

afterEach(async () => {
  await dataSource.destroy();
});

function serviceWith(grantMicros: number): { grants: SignUpGrantService; ledger: LedgerService } {
  const config = testConfig({ CR_API_BILLING__SIGNUP_GRANT_MICROS: String(grantMicros) });
  const ledger = new LedgerService(dataSource, config);
  return { grants: new SignUpGrantService(config, ledger), ledger };
}

async function entries(): Promise<CreditTransaction[]> {
  return dataSource.getRepository(CreditTransaction).findBy({ workspaceId });
}

/** `data-model.md` invariant 3: the balance is the sum of the ledger. */
async function assertBalanceMatchesLedger(): Promise<number> {
  const sum = (await entries()).reduce((total, entry) => total + entry.amountMicros, 0);
  const { balanceMicros } = await dataSource.getRepository(Workspace).findOneByOrFail({ id: workspaceId });
  expect(balanceMicros).toBe(sum);
  return sum;
}

describe('the sign-up grant', () => {
  it('defaults to nothing on a bare config', () => {
    expect(testConfig().billing.signupGrantMicros).toBe(0);
  });

  it('credits a new account once, as a grant referenced "signup"', async () => {
    const { grants } = serviceWith(TWENTY_USD);
    const userId = randomUUID();

    const outcome = await grants.grantOnSignUp({ userId, workspaceId });

    expect(outcome).toMatchObject({ status: 'granted', grantMicros: TWENTY_USD });
    expect(await assertBalanceMatchesLedger()).toBe(TWENTY_USD);
    expect(await entries()).toEqual([
      expect.objectContaining({
        kind: 'grant',
        amountMicros: TWENTY_USD,
        reference: 'signup',
        idempotencyKey: `signup:${userId}`,
      }),
    ]);
  });

  it('writes nothing when the operator set it to 0', async () => {
    const { grants } = serviceWith(0);

    expect(await grants.grantOnSignUp({ userId: randomUUID(), workspaceId })).toEqual({ status: 'disabled' });
    expect(await entries()).toEqual([]);
    expect(await assertBalanceMatchesLedger()).toBe(0);
  });

  it('a replayed hook collapses onto the first grant', async () => {
    const { grants } = serviceWith(TWENTY_USD);
    const userId = randomUUID();

    const first = await grants.grantOnSignUp({ userId, workspaceId });
    const second = await grants.grantOnSignUp({ userId, workspaceId });

    expect(second).toEqual({
      status: 'replayed',
      creditTransactionId: first.status === 'granted' ? first.creditTransactionId : 'unreachable',
    });
    expect(await entries()).toHaveLength(1);
    expect(await assertBalanceMatchesLedger()).toBe(TWENTY_USD);
  });

  it('racing creations of the same account still grant exactly once', async () => {
    const { grants } = serviceWith(TWENTY_USD);
    const userId = randomUUID();

    const outcomes = await Promise.all(Array.from({ length: 8 }, () => grants.grantOnSignUp({ userId, workspaceId })));

    expect(outcomes.filter((outcome) => outcome.status === 'granted')).toHaveLength(1);
    expect(outcomes.every((outcome) => outcome.status === 'granted' || outcome.status === 'replayed')).toBe(true);
    expect(await entries()).toHaveLength(1);
    expect(await assertBalanceMatchesLedger()).toBe(TWENTY_USD);
  });

  it('stacks with an invitation grant: signup 20 + invite 100 = 120', async () => {
    const { grants, ledger } = serviceWith(TWENTY_USD);
    const invites = new InvitesService(dataSource, testConfig(), ledger);
    const userId = randomUUID();
    // An invitation's credit, written the way the invitation path writes it.
    await ledger.record({
      workspaceId,
      kind: 'grant',
      amountMicros: 100_000_000,
      reference: 'launch-2026-10',
      idempotencyKey: `invite:${randomUUID()}:${userId}`,
    });

    await grants.grantOnSignUp({ userId, workspaceId });
    // A sign-up with no code leaves the sign-up grant alone.
    expect(await invites.redeemOnSignUp({ userId, workspaceId, invite: NO_SIGN_UP_INVITE })).toEqual({
      status: 'none',
    });

    expect(await assertBalanceMatchesLedger()).toBe(120_000_000);
  });

  it('never throws: a ledger failure comes back as a refusal', async () => {
    const { grants } = serviceWith(TWENTY_USD);

    const outcome = await grants.grantOnSignUp({ userId: randomUUID(), workspaceId: randomUUID() });

    expect(outcome).toEqual({ status: 'refused', reason: 'error' });
  });
});
