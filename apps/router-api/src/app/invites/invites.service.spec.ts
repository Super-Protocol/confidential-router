import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDataSource, seedCatalog, testConfig } from '../../../test/seed.js';
import { LedgerService } from '../billing/ledger.service.js';
import { CreditTransaction } from '../db/entities/credit-transaction.entity.js';
import { InviteCode } from '../db/entities/invite-code.entity.js';
import { InviteRedemption } from '../db/entities/invite-redemption.entity.js';
import { Workspace } from '../db/entities/workspace.entity.js';
import { formatInviteCode, mintInviteCode } from './invite-code.js';
import { InvitesService } from './invites.service.js';
import { NO_SIGN_UP_INVITE, type SignUpInvite } from './sign-up-invite.js';

/**
 * The constraints, executed.
 *
 * Every refusal is asserted twice: the outcome the caller sees, and the state of
 * the database afterwards — a redemption that reported "refused" while leaving
 * credit behind would pass the first assertion alone.
 */

const GRANT = 100_000_000;

let dataSource: DataSource;
let invites: InvitesService;
let workspaceId: string;

beforeEach(async () => {
  dataSource = await createTestDataSource();
  const config = testConfig();
  invites = new InvitesService(dataSource, config, new LedgerService(dataSource, config));
  ({ workspaceId } = await seedCatalog(dataSource));
});

afterEach(async () => {
  await dataSource.destroy();
});

interface SeedCode {
  grantMicros?: number;
  campaign?: string;
  maxRedemptions?: number;
  expiresAt?: Date | null;
  disabledAt?: Date | null;
}

async function seedCode(seed: SeedCode = {}): Promise<InviteCode> {
  const values = {
    id: randomUUID(),
    code: mintInviteCode(),
    grantMicros: seed.grantMicros ?? GRANT,
    campaign: seed.campaign ?? 'launch-2026-10',
    maxRedemptions: seed.maxRedemptions ?? 1,
    redemptionCount: 0,
    expiresAt: seed.expiresAt ?? null,
    disabledAt: seed.disabledAt ?? null,
    note: null,
    createdAt: new Date(),
  };
  await dataSource.getRepository(InviteCode).insert(values);
  return dataSource.getRepository(InviteCode).create(values);
}

function signUp(code: string, overrides: Partial<SignUpInvite> = {}): SignUpInvite {
  return { ...NO_SIGN_UP_INVITE, code, ...overrides };
}

function redeem(code: string, userId = randomUUID()) {
  return invites.redeemOnSignUp({ userId, workspaceId, invite: signUp(code) });
}

async function balance(): Promise<number> {
  return (await dataSource.getRepository(Workspace).findOneByOrFail({ id: workspaceId })).balanceMicros;
}

/** `data-model.md` invariant 3, which a grant must not break either. */
async function assertBalanceMatchesLedger(): Promise<number> {
  const entries = await dataSource.getRepository(CreditTransaction).findBy({ workspaceId });
  const sum = entries.reduce((total, entry) => total + entry.amountMicros, 0);
  expect(await balance()).toBe(sum);
  return sum;
}

describe('looking a code up', () => {
  it('reports what a usable code grants, case- and separator-insensitively', async () => {
    const code = await seedCode();

    expect(await invites.lookup(formatInviteCode(code.code).toLowerCase())).toEqual({
      valid: true,
      grantMicros: GRANT,
      campaign: 'launch-2026-10',
    });
  });

  it('says not_found for a code that never existed and for outright garbage', async () => {
    expect(await invites.lookup(mintInviteCode())).toEqual({ valid: false, reason: 'not_found' });
    expect(await invites.lookup('nonsense')).toEqual({ valid: false, reason: 'not_found' });
    expect(await invites.lookup('')).toEqual({ valid: false, reason: 'not_found' });
  });

  it('distinguishes expired, exhausted and disabled — for the operator, not for the public endpoint', async () => {
    const expired = await seedCode({ expiresAt: new Date('2020-01-01T00:00:00Z') });
    const disabled = await seedCode({ disabledAt: new Date('2026-09-01T00:00:00Z') });
    const spent = await seedCode();
    await redeem(spent.code);

    expect(await invites.lookup(expired.code)).toEqual({ valid: false, reason: 'expired' });
    expect(await invites.lookup(disabled.code)).toEqual({ valid: false, reason: 'disabled' });
    expect(await invites.lookup(spent.code)).toEqual({ valid: false, reason: 'exhausted' });
  });

  it('calls a code that expires exactly now expired — the boundary belongs to the past', async () => {
    const now = new Date('2026-10-01T00:00:00Z');
    const code = await seedCode({ expiresAt: now });

    expect(await invites.lookup(code.code, now)).toEqual({ valid: false, reason: 'expired' });
  });
});

describe('redeeming inside sign-up', () => {
  it('credits the workspace once and records the redemption against the ledger row', async () => {
    const code = await seedCode();
    const userId = randomUUID();

    const outcome = await invites.redeemOnSignUp({
      userId,
      workspaceId,
      invite: signUp(formatInviteCode(code.code), { ip: '203.0.113.7', userAgent: 'Firefox' }),
    });

    expect(outcome).toMatchObject({ status: 'granted', grantMicros: GRANT, campaign: 'launch-2026-10' });
    expect(await assertBalanceMatchesLedger()).toBe(GRANT);

    const entry = await dataSource.getRepository(CreditTransaction).findOneByOrFail({ workspaceId });
    expect(entry).toMatchObject({
      kind: 'grant',
      amountMicros: GRANT,
      reference: 'launch-2026-10',
      idempotencyKey: `invite:${code.id}:${userId}`,
    });

    const redemption = await dataSource.getRepository(InviteRedemption).findOneByOrFail({ userId });
    expect(redemption.creditTransactionId).toBe(entry.id);
    expect(await dataSource.getRepository(InviteCode).findOneByOrFail({ id: code.id })).toMatchObject({
      redemptionCount: 1,
    });
  });

  it('stores fingerprints, never the address or the user agent', async () => {
    const code = await seedCode();
    const userId = randomUUID();

    await invites.redeemOnSignUp({
      userId,
      workspaceId,
      invite: signUp(code.code, { ip: '203.0.113.7', userAgent: 'Mozilla/5.0' }),
    });

    const redemption = await dataSource.getRepository(InviteRedemption).findOneByOrFail({ userId });
    expect(redemption.ipHash).toMatch(/^[0-9a-f]{64}$/);
    expect(redemption.userAgentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(redemption)).not.toContain('203.0.113.7');
    expect(JSON.stringify(redemption)).not.toContain('Mozilla/5.0');
  });

  it('does nothing at all when the sign-up carried no code', async () => {
    expect(await invites.redeemOnSignUp({ userId: randomUUID(), workspaceId, invite: NO_SIGN_UP_INVITE })).toEqual({
      status: 'none',
    });
    expect(await balance()).toBe(0);
  });

  it('refuses garbage without touching the balance — the account still exists', async () => {
    expect(await redeem('not-a-real-code')).toEqual({ status: 'refused', reason: 'not_found' });
    expect(await redeem(mintInviteCode())).toEqual({ status: 'refused', reason: 'not_found' });
    expect(await balance()).toBe(0);
  });

  it('refuses an expired, a disabled and an exhausted code, and credits none of them', async () => {
    const expired = await seedCode({ expiresAt: new Date('2020-01-01T00:00:00Z') });
    const disabled = await seedCode({ disabledAt: new Date('2026-09-01T00:00:00Z') });
    const spent = await seedCode();
    await redeem(spent.code);
    const creditedByTheOneThatWorked = GRANT;

    expect(await redeem(expired.code)).toEqual({ status: 'refused', reason: 'expired' });
    expect(await redeem(disabled.code)).toEqual({ status: 'refused', reason: 'disabled' });
    expect(await redeem(spent.code)).toEqual({ status: 'refused', reason: 'exhausted' });

    expect(await assertBalanceMatchesLedger()).toBe(creditedByTheOneThatWorked);
    expect(await dataSource.getRepository(InviteRedemption).count()).toBe(1);
  });

  it('honours maxRedemptions above one, and stops at it', async () => {
    const code = await seedCode({ maxRedemptions: 3 });

    for (let seat = 0; seat < 3; seat += 1) {
      expect(await redeem(code.code)).toMatchObject({ status: 'granted' });
    }
    expect(await redeem(code.code)).toEqual({ status: 'refused', reason: 'exhausted' });

    expect(await assertBalanceMatchesLedger()).toBe(3 * GRANT);
  });
});

describe('one grant per account, ever', () => {
  it('refuses a second code to an account that already redeemed one', async () => {
    const first = await seedCode();
    const second = await seedCode({ campaign: 'launch-2026-11' });
    const userId = randomUUID();

    expect(await redeem(first.code, userId)).toMatchObject({ status: 'granted' });
    expect(await redeem(second.code, userId)).toEqual({ status: 'refused', reason: 'already_redeemed' });

    expect(await assertBalanceMatchesLedger()).toBe(GRANT);
    // The refused attempt must not have burned the second code's only seat.
    expect(await dataSource.getRepository(InviteCode).findOneByOrFail({ id: second.id })).toMatchObject({
      redemptionCount: 0,
    });
  });

  it('refuses the same code twice to the same account — the idempotency key alone would too', async () => {
    const code = await seedCode({ maxRedemptions: 5 });
    const userId = randomUUID();

    expect(await redeem(code.code, userId)).toMatchObject({ status: 'granted' });
    expect(await redeem(code.code, userId)).toEqual({ status: 'refused', reason: 'already_redeemed' });

    expect(await assertBalanceMatchesLedger()).toBe(GRANT);
    expect(await dataSource.getRepository(CreditTransaction).countBy({ workspaceId })).toBe(1);
  });
});

describe('two sign-ups racing', () => {
  it('loses exactly once on the last seat', async () => {
    const code = await seedCode();

    const outcomes = await Promise.all([redeem(code.code), redeem(code.code)]);

    expect(outcomes.filter((outcome) => outcome.status === 'granted')).toHaveLength(1);
    // `exhausted` and not `already_redeemed`: both callers read the code while it
    // still had its seat, so the refusal came from the claim's own
    // `WHERE redemptionCount < maxRedemptions` and not from the read before it.
    expect(outcomes).toContainEqual({ status: 'refused', reason: 'exhausted' });

    expect(await assertBalanceMatchesLedger()).toBe(GRANT);
    expect(await dataSource.getRepository(InviteRedemption).count()).toBe(1);
    expect(await dataSource.getRepository(InviteCode).findOneByOrFail({ id: code.id })).toMatchObject({
      redemptionCount: 1,
    });
  });

  it('grants exactly the number of seats a code has, however many arrive at once', async () => {
    const code = await seedCode({ maxRedemptions: 3 });

    const outcomes = await Promise.all(Array.from({ length: 8 }, () => redeem(code.code)));

    expect(outcomes.filter((outcome) => outcome.status === 'granted')).toHaveLength(3);
    expect(await assertBalanceMatchesLedger()).toBe(3 * GRANT);
    expect(await dataSource.getRepository(InviteRedemption).count()).toBe(3);
  });

  it('credits one account once when the same sign-up is processed twice concurrently', async () => {
    const code = await seedCode({ maxRedemptions: 5 });
    const userId = randomUUID();

    const outcomes = await Promise.all([redeem(code.code, userId), redeem(code.code, userId)]);

    expect(outcomes.filter((outcome) => outcome.status === 'granted')).toHaveLength(1);
    expect(await assertBalanceMatchesLedger()).toBe(GRANT);
    expect(await dataSource.getRepository(CreditTransaction).countBy({ workspaceId })).toBe(1);
  });
});

describe('a failure that is ours', () => {
  it('reports it and leaves the account alone, rather than failing the sign-up', async () => {
    const code = await seedCode();

    // A workspace id that does not exist: the ledger cannot credit it. The
    // registration has already happened by this point, so the only acceptable
    // outcome is a refusal.
    const outcome = await invites.redeemOnSignUp({
      userId: randomUUID(),
      workspaceId: randomUUID(),
      invite: signUp(code.code),
    });

    expect(outcome).toEqual({ status: 'refused', reason: 'error' });
    expect(await dataSource.getRepository(InviteRedemption).count()).toBe(0);
    // Nothing was claimed either: the seat is still there for whoever it was for.
    expect(await dataSource.getRepository(InviteCode).findOneByOrFail({ id: code.id })).toMatchObject({
      redemptionCount: 0,
    });
  });
});

describe('the viewer’s grant', () => {
  it('is the redemption with its code, so the console can name the campaign', async () => {
    const code = await seedCode();
    const userId = randomUUID();
    await redeem(code.code, userId);

    const redemption = await invites.redemptionOf(userId);

    expect(redemption?.inviteCode).toMatchObject({ campaign: 'launch-2026-10', grantMicros: GRANT });
  });

  it('is null for an account that never redeemed one', async () => {
    expect(await invites.redemptionOf(randomUUID())).toBeNull();
  });
});
