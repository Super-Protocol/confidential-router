import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDataSource, seedCatalog, testConfig } from '../../../test/seed.js';
import { LedgerService } from '../billing/ledger.service.js';
import { CreditTransaction } from '../db/entities/credit-transaction.entity.js';
import { InviteCode } from '../db/entities/invite-code.entity.js';
import { InviteRedemption } from '../db/entities/invite-redemption.entity.js';
import { Workspace } from '../db/entities/workspace.entity.js';
import { formatInviteCode } from './invite-code.js';
import { generateInvites } from './invite-generator.js';
import {
  describeRestoration,
  describeWithdrawal,
  type InviteRestoration,
  InviteTargetError,
  type InviteWithdrawal,
  InviteWithdrawalService,
} from './invite-withdrawal.service.js';
import { InvitesService } from './invites.service.js';
import { NO_SIGN_UP_INVITE } from './sign-up-invite.js';

/**
 * The kill switch, and the one property the launch rehearsal asked to be sure of
 * (SUP-148, SUP-159): withdrawing a campaign mid-flight must stop the *next*
 * sign-up and leave every account that already redeemed byte-for-byte alone.
 */

const CAMPAIGN = 'launch-2026-10-devs';
const GRANT_MICROS = 100_000_000;

let dataSource: DataSource;
let withdrawals: InviteWithdrawalService;
let invites: InvitesService;

beforeEach(async () => {
  dataSource = await createTestDataSource();
  const config = testConfig();
  withdrawals = new InviteWithdrawalService(dataSource);
  invites = new InvitesService(dataSource, config, new LedgerService(dataSource, config));
});

afterEach(async () => {
  await dataSource.destroy();
});

/** One campaign's codes, minted through the same generator the CLI uses. */
async function issue(count: number, campaign = CAMPAIGN): Promise<string[]> {
  const generated = await generateInvites(dataSource, {
    count,
    grantMicros: GRANT_MICROS,
    campaign,
    maxRedemptions: 1,
    expiresAt: null,
    note: null,
    landingBaseUrl: 'https://router.superprotocol.com',
  });
  return generated.map((invite) => invite.code);
}

/** A sign-up that redeems one code, exactly as account creation does it. */
async function redeem(code: string): Promise<string> {
  const { workspaceId } = await seedCatalog(dataSource);
  const outcome = await invites.redeemOnSignUp({
    userId: randomUUID(),
    workspaceId,
    invite: { ...NO_SIGN_UP_INVITE, code },
  });
  expect(outcome.status).toBe('granted');
  return workspaceId;
}

function stored(code: string): Promise<InviteCode | null> {
  return dataSource.getRepository(InviteCode).findOne({ where: { code: code.replaceAll('-', '') } });
}

describe('withdrawing one code', () => {
  it('stops the next redemption, and says so with its reason', async () => {
    const [code] = await issue(1);

    const result = await withdrawals.withdraw({ code });

    expect(result).toEqual({
      target: code,
      matched: 1,
      withdrawn: 1,
      alreadyWithdrawn: 0,
      spent: 0,
    });
    expect(await invites.lookup(code)).toEqual({ valid: false, reason: 'disabled' });
    const { workspaceId } = await seedCatalog(dataSource);
    expect(
      await invites.redeemOnSignUp({ userId: randomUUID(), workspaceId, invite: { ...NO_SIGN_UP_INVITE, code } }),
    ).toEqual({ status: 'refused', reason: 'disabled' });
  });

  it('takes the code in any spelling the invitation carried', async () => {
    const [code] = await issue(1);

    const result = await withdrawals.withdraw({ code: `  ${code.toLowerCase().replaceAll('-', ' ')} ` });

    expect(result.withdrawn).toBe(1);
    // Echoed back in the display form, whatever was typed.
    expect(result.target).toBe(code);
  });

  it('is idempotent, and does not move the timestamp on the second run', async () => {
    const [code] = await issue(1);
    const first = new Date('2026-10-01T00:00:00.000Z');
    await withdrawals.withdraw({ code }, first);

    const again = await withdrawals.withdraw({ code }, new Date('2026-10-02T00:00:00.000Z'));

    expect(again).toMatchObject({ matched: 1, withdrawn: 0, alreadyWithdrawn: 1 });
    expect((await stored(code))?.disabledAt?.toISOString()).toBe(first.toISOString());
  });

  it('reports nothing matched for a code that was never issued', async () => {
    await issue(1);

    const result = await withdrawals.withdraw({ code: 'ZZZZ-ZZZZ-ZZZZ' });

    expect(result).toMatchObject({ matched: 0, withdrawn: 0 });
  });
});

describe('withdrawing a campaign', () => {
  it('withdraws every code it has, and leaves another campaign alone', async () => {
    const ours = await issue(3);
    const [other] = await issue(1, 'launch-2026-11');

    const result = await withdrawals.withdraw({ campaign: CAMPAIGN });

    expect(result).toMatchObject({ target: CAMPAIGN, matched: 3, withdrawn: 3, alreadyWithdrawn: 0, spent: 0 });
    for (const code of ours) {
      expect((await stored(code))?.disabledAt).not.toBeNull();
    }
    expect((await stored(other))?.disabledAt).toBeNull();
  });

  it('leaves the spent codes in circulation when asked to, and counts them', async () => {
    const [spent, unspent] = await issue(2);
    await redeem(spent);

    const result = await withdrawals.withdraw({ campaign: CAMPAIGN, unspentOnly: true });

    expect(result).toMatchObject({ matched: 2, withdrawn: 1, spent: 1 });
    expect((await stored(spent))?.disabledAt).toBeNull();
    expect((await stored(unspent))?.disabledAt).not.toBeNull();
  });

  it('reports nothing matched for a campaign tag that has no codes', async () => {
    await issue(2);

    expect(await withdrawals.withdraw({ campaign: 'Launch-2026-10-Devs' })).toMatchObject({
      matched: 0,
      withdrawn: 0,
    });
  });

  /**
   * The property SUP-148 asked for, against the real entities: a campaign-wide
   * withdrawal is not a clawback. Pinned here because the whole rollback plan
   * rests on it — an operator who cannot be sure of this cannot use the kill
   * switch at all.
   */
  it('does not touch a grant already made', async () => {
    const [spent, unspent] = await issue(2);
    const workspaceId = await redeem(spent);
    const before = {
      balance: (await dataSource.getRepository(Workspace).findOneByOrFail({ id: workspaceId })).balanceMicros,
      ledger: await dataSource.getRepository(CreditTransaction).findBy({ workspaceId }),
      redemptions: await dataSource.getRepository(InviteRedemption).find(),
    };

    await withdrawals.withdraw({ campaign: CAMPAIGN });

    expect((await dataSource.getRepository(Workspace).findOneByOrFail({ id: workspaceId })).balanceMicros).toBe(
      GRANT_MICROS,
    );
    expect(before.balance).toBe(GRANT_MICROS);
    expect(await dataSource.getRepository(CreditTransaction).findBy({ workspaceId })).toEqual(before.ledger);
    expect(await dataSource.getRepository(InviteRedemption).find()).toEqual(before.redemptions);
    // And the campaign is closed to everyone who has not redeemed yet.
    expect(await invites.lookup(unspent)).toEqual({ valid: false, reason: 'disabled' });
  });
});

describe('restoring', () => {
  it('puts a withdrawn code back into circulation', async () => {
    const [code] = await issue(1);
    await withdrawals.withdraw({ code });

    const result = await withdrawals.restore({ code });

    expect(result).toEqual({ target: code, matched: 1, restored: 1, alreadyUsable: 0 });
    expect(await invites.lookup(code)).toEqual({ valid: true, grantMicros: GRANT_MICROS, campaign: CAMPAIGN });
  });

  it('undoes a whole campaign, and counts the codes that were never withdrawn', async () => {
    const codes = await issue(3);
    await withdrawals.withdraw({ code: codes[0] });

    const result = await withdrawals.restore({ campaign: CAMPAIGN });

    expect(result).toMatchObject({ matched: 3, restored: 1, alreadyUsable: 2 });
    for (const code of codes) {
      expect((await stored(code))?.disabledAt).toBeNull();
    }
  });

  it('does not make an expired code usable again', async () => {
    const [code] = await issue(1, CAMPAIGN);
    await dataSource.getRepository(InviteCode).update({ campaign: CAMPAIGN }, { expiresAt: new Date('2020-01-01') });
    await withdrawals.withdraw({ code });

    await withdrawals.restore({ code });

    expect(await invites.lookup(code)).toEqual({ valid: false, reason: 'expired' });
  });
});

describe('the target', () => {
  it('refuses a request that names neither a code nor a campaign', async () => {
    await expect(withdrawals.withdraw({})).rejects.toThrow(InviteTargetError);
    await expect(withdrawals.withdraw({ code: '   ', campaign: '' })).rejects.toThrow(InviteTargetError);
  });

  it('refuses a request that names both', async () => {
    await expect(withdrawals.withdraw({ code: formatInviteCode('ABCDEFGHJKMN'), campaign: CAMPAIGN })).rejects.toThrow(
      InviteTargetError,
    );
  });

  /**
   * A mistyped code and a code that does not exist are different problems, and
   * the operator has to be sent to a different place for each.
   */
  it('refuses something that is not the shape of a code, rather than matching nothing', async () => {
    await expect(withdrawals.withdraw({ code: 'ABCD-EFGH' })).rejects.toThrow(/not the shape/);
    // `O`, `0`, `1` and `U` are not in the alphabet; a transcription slip is not a code.
    await expect(withdrawals.withdraw({ code: 'ABCD-EFGH-JK0N' })).rejects.toThrow(InviteTargetError);
  });
});

describe('what the operator is told', () => {
  function withdrawal(overrides: Partial<InviteWithdrawal> = {}): InviteWithdrawal {
    return { target: CAMPAIGN, matched: 5000, withdrawn: 5000, alreadyWithdrawn: 0, spent: 0, ...overrides };
  }

  function restoration(overrides: Partial<InviteRestoration> = {}): InviteRestoration {
    return { target: CAMPAIGN, matched: 5000, restored: 5000, alreadyUsable: 0, ...overrides };
  }

  it('leads with the count, because that is the whole answer', () => {
    expect(describeWithdrawal(withdrawal())).toBe(`${CAMPAIGN}: withdrew 5000 of 5000 codes.`);
    expect(describeRestoration(restoration())).toBe(`${CAMPAIGN}: restored 5000 of 5000 codes.`);
  });

  it('names what it left alone', () => {
    expect(describeWithdrawal(withdrawal({ withdrawn: 4996, alreadyWithdrawn: 2, spent: 2 }))).toBe(
      `${CAMPAIGN}: withdrew 4996 of 5000 codes (2 already withdrawn, 2 spent and left in circulation).`,
    );
    expect(describeRestoration(restoration({ restored: 4998, alreadyUsable: 2 }))).toBe(
      `${CAMPAIGN}: restored 4998 of 5000 codes (2 were not withdrawn).`,
    );
  });

  /** The line an operator must not read as success. */
  it('says plainly when nothing matched', () => {
    expect(describeWithdrawal(withdrawal({ matched: 0, withdrawn: 0 }))).toBe(
      `${CAMPAIGN}: nothing matched. No codes were changed.`,
    );
    expect(describeRestoration(restoration({ matched: 0, restored: 0 }))).toBe(
      `${CAMPAIGN}: nothing matched. No codes were changed.`,
    );
  });
});
