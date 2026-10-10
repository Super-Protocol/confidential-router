import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDataSource, seedCatalog, testConfig } from '../../../test/seed.js';
import { LedgerService } from '../billing/ledger.service.js';
import { InviteCode } from '../db/entities/invite-code.entity.js';
import { InviteRedemption } from '../db/entities/invite-redemption.entity.js';
import { InviteAdminService, type InviteCodeStatus, inviteCodeStatus, signUpOrigin } from './invite-admin.service.js';
import { InviteAttributionService } from './invite-attribution.service.js';
import { generateInvites } from './invite-generator.js';
import { InviteStatsService } from './invite-stats.service.js';
import { InviteWithdrawalService } from './invite-withdrawal.service.js';
import { InvitesService } from './invites.service.js';
import { NO_SIGN_UP_INVITE } from './sign-up-invite.js';

/**
 * The admin console's reads (SUP-268): the code list with who redeemed each, the
 * account list with where each came from, and the deployment-wide numbers the
 * statistics tab charts.
 */

const BOOTSTRAP_EMAIL = 'admin@confidential-router.local';
const NOW = new Date('2026-10-09T12:00:00Z');

let dataSource: DataSource;
let admin: InviteAdminService;
let attribution: InviteAttributionService;
let stats: InviteStatsService;
let invites: InvitesService;

beforeEach(async () => {
  dataSource = await createTestDataSource();
  const config = testConfig();
  attribution = new InviteAttributionService(dataSource);
  admin = new InviteAdminService(dataSource, attribution);
  stats = new InviteStatsService(dataSource);
  invites = new InvitesService(dataSource, config, new LedgerService(dataSource, config));
  // Better Auth owns `user` and creates it with its own migration, which a unit
  // test does not run. The columns `User` maps are all the reads here need.
  await dataSource.query(
    'CREATE TABLE "user" ("id" varchar PRIMARY KEY, "email" varchar NOT NULL, "name" varchar NOT NULL, "image" varchar, "createdAt" date NOT NULL)',
  );
});

afterEach(async () => {
  await dataSource.destroy();
});

async function account(email: string, createdAt: Date): Promise<string> {
  const id = randomUUID();
  await dataSource.query('INSERT INTO "user" ("id", "email", "name", "createdAt") VALUES (?, ?, ?, ?)', [
    id,
    email,
    '',
    createdAt.toISOString(),
  ]);
  return id;
}

async function issue(
  count: number,
  overrides: Partial<Parameters<typeof generateInvites>[1]> = {},
): Promise<{ id: string; code: string }[]> {
  return generateInvites(dataSource, {
    count,
    grantMicros: 100_000_000,
    campaign: 'launch-2026-10',
    maxRedemptions: 1,
    expiresAt: null,
    note: null,
    landingBaseUrl: 'https://router.superprotocol.com',
    ...overrides,
  });
}

async function redeem(code: string, userId: string): Promise<void> {
  const { workspaceId } = await seedCatalog(dataSource);
  const outcome = await invites.redeemOnSignUp({ userId, workspaceId, invite: { ...NO_SIGN_UP_INVITE, code } });
  expect(outcome.status).toBe('granted');
}

describe('the code list', () => {
  it('names who redeemed a code and who issued it', async () => {
    const operator = await account('ops@example.com', new Date('2026-10-01T00:00:00Z'));
    const [issued] = await issue(1, { issuedByUserId: operator });
    const redeemer = await account('dev@example.com', new Date('2026-10-02T00:00:00Z'));
    await redeem(issued.code, redeemer);

    const page = await admin.codes({ offset: 0, limit: 10 }, NOW);

    expect(page.totalCount).toBe(1);
    expect(page.nodes[0]).toMatchObject({
      id: issued.id,
      code: issued.code.replaceAll('-', ''),
      status: 'redeemed',
      issuedByEmail: 'ops@example.com',
      redemptionCount: 1,
      redeemers: [{ userId: redeemer, email: 'dev@example.com' }],
    });
  });

  it('says nobody issued a CLI-minted code, rather than guessing', async () => {
    await issue(1);

    const [code] = (await admin.codes({ offset: 0, limit: 10 }, NOW)).nodes;

    expect(code.issuedByEmail).toBeNull();
    expect(code.redeemers).toEqual([]);
  });

  it('pages newest first and counts across every page', async () => {
    await issue(3, { campaign: 'older' });
    await dataSource.getRepository(InviteCode).update({ campaign: 'older' }, { createdAt: new Date('2026-09-01') });
    await issue(2, { campaign: 'newer' });

    const first = await admin.codes({ offset: 0, limit: 2 }, NOW);
    const rest = await admin.codes({ offset: 2, limit: 10 }, NOW);

    expect(first.totalCount).toBe(5);
    expect(first.nodes.map((code) => code.campaign)).toEqual(['newer', 'newer']);
    expect(rest.nodes.map((code) => code.campaign)).toEqual(['older', 'older', 'older']);
  });

  it('filters by campaign', async () => {
    await issue(2, { campaign: 'a' });
    await issue(1, { campaign: 'b' });

    const page = await admin.codes({ campaign: 'b', offset: 0, limit: 10 }, NOW);

    expect(page.totalCount).toBe(1);
    expect(page.nodes[0].campaign).toBe('b');
  });

  it('filters every status in SQL exactly as it labels them', async () => {
    const [active, redeemed, expired, withdrawn, withdrawnAndRedeemed] = await issue(5);
    await redeem(redeemed.code, await account('a@example.com', NOW));
    await redeem(withdrawnAndRedeemed.code, await account('b@example.com', NOW));
    await dataSource
      .getRepository(InviteCode)
      .update({ id: expired.id }, { expiresAt: new Date(NOW.getTime() - 1000) });
    await dataSource.getRepository(InviteCode).update({ id: withdrawn.id }, { disabledAt: NOW });
    await dataSource.getRepository(InviteCode).update({ id: withdrawnAndRedeemed.id }, { disabledAt: NOW });

    const expected: Record<InviteCodeStatus, string[]> = {
      active: [active.id],
      redeemed: [redeemed.id],
      expired: [expired.id],
      withdrawn: [withdrawn.id, withdrawnAndRedeemed.id],
    };
    const all = await admin.codes({ offset: 0, limit: 10 }, NOW);
    for (const [status, ids] of Object.entries(expected) as [InviteCodeStatus, string[]][]) {
      const page = await admin.codes({ status, offset: 0, limit: 10 }, NOW);
      expect(page.nodes.map((code) => code.id).sort(), status).toEqual([...ids].sort());
      expect(
        all.nodes
          .filter((code) => code.status === status)
          .map((code) => code.id)
          .sort(),
      ).toEqual([...ids].sort());
    }
  });
});

describe('a code’s status', () => {
  const base = { disabledAt: null, expiresAt: null, redemptionCount: 0, maxRedemptions: 1 };

  it('puts a withdrawal before everything else', () => {
    expect(inviteCodeStatus({ ...base, disabledAt: NOW, redemptionCount: 1 }, NOW)).toBe('withdrawn');
  });

  it('reads a spent code as redeemed even after it expires', () => {
    expect(inviteCodeStatus({ ...base, redemptionCount: 1, expiresAt: new Date('2020-01-01') }, NOW)).toBe('redeemed');
  });

  it('keeps a multi-seat code active until its last seat goes', () => {
    expect(inviteCodeStatus({ ...base, redemptionCount: 2, maxRedemptions: 3 }, NOW)).toBe('active');
  });
});

describe('the account list', () => {
  it('says which code each invited account came with, and calls the rest bootstrap or open', async () => {
    const operator = await account(BOOTSTRAP_EMAIL, new Date('2026-10-01T00:00:00Z'));
    const [issued] = await issue(1);
    const invited = await account('invited@example.com', new Date('2026-10-02T00:00:00Z'));
    await redeem(issued.code, invited);
    const open = await account('open@example.com', new Date('2026-10-03T00:00:00Z'));

    const page = await admin.signUps({ offset: 0, limit: 10 }, BOOTSTRAP_EMAIL);

    expect(page.totalCount).toBe(3);
    expect(page.nodes.map((row) => [row.userId, row.origin])).toEqual([
      [open, 'open'],
      [invited, 'invite'],
      [operator, 'bootstrap'],
    ]);
    expect(page.nodes[1].invite).toMatchObject({
      inviteCodeId: issued.id,
      code: issued.code.replaceAll('-', ''),
      campaign: 'launch-2026-10',
    });
    expect(page.nodes[0].invite).toBeNull();
  });

  it('filters by origin', async () => {
    await account(BOOTSTRAP_EMAIL, new Date('2026-10-01T00:00:00Z'));
    const [issued] = await issue(1);
    const invited = await account('invited@example.com', new Date('2026-10-02T00:00:00Z'));
    await redeem(issued.code, invited);
    const open = await account('open@example.com', new Date('2026-10-03T00:00:00Z'));

    const only = async (origin: 'invite' | 'bootstrap' | 'open') =>
      (await admin.signUps({ origin, offset: 0, limit: 10 }, BOOTSTRAP_EMAIL)).nodes.map((row) => row.userId);

    expect(await only('invite')).toEqual([invited]);
    expect(await only('open')).toEqual([open]);
    expect(await only('bootstrap')).toHaveLength(1);
  });

  it('finds no bootstrap account when the first account has another address', async () => {
    await account('first@example.com', new Date('2026-10-01T00:00:00Z'));
    // Same address as the bootstrap one, but not the first account: the plugin
    // only ever creates the first, so this one signed up some other way.
    await account(BOOTSTRAP_EMAIL, new Date('2026-10-02T00:00:00Z'));

    expect(await admin.bootstrapAccountId(BOOTSTRAP_EMAIL)).toBeNull();
    const bootstrap = await admin.signUps({ origin: 'bootstrap', offset: 0, limit: 10 }, BOOTSTRAP_EMAIL);
    expect(bootstrap.totalCount).toBe(0);
  });

  it('labels an origin from the redemption first', () => {
    expect(signUpOrigin('u', true, 'u')).toBe('invite');
    expect(signUpOrigin('u', false, 'u')).toBe('bootstrap');
    expect(signUpOrigin('u', false, null)).toBe('open');
  });
});

describe('the deployment-wide numbers', () => {
  it('totals what was issued, redeemed, withdrawn and granted', async () => {
    const [one, two] = await issue(4, { grantMicros: 25_000_000 });
    await redeem(one.code, await account('a@example.com', NOW));
    await redeem(two.code, await account('b@example.com', NOW));
    await new InviteWithdrawalService(dataSource).withdraw({ campaign: 'launch-2026-10', unspentOnly: true });
    await account('open@example.com', NOW);

    expect(await stats.totals()).toEqual({
      issued: 4,
      redeemed: 2,
      withdrawn: 2,
      redemptionRate: 0.5,
      grantedMicros: 50_000_000,
      signUps: 3,
    });
  });

  it('answers zeros, not NaN, on a deployment with nothing', async () => {
    expect(await stats.totals()).toEqual({
      issued: 0,
      redeemed: 0,
      withdrawn: 0,
      redemptionRate: 0,
      grantedMicros: 0,
      signUps: 0,
    });
  });

  it('buckets the daily series by UTC day, with every day present', async () => {
    const operator = await account(BOOTSTRAP_EMAIL, new Date('2026-10-07T09:00:00Z'));
    const [issued] = await issue(3);
    await dataSource
      .getRepository(InviteCode)
      .update({ campaign: 'launch-2026-10' }, { createdAt: new Date('2026-10-07T10:00:00Z') });
    const invited = await account('invited@example.com', new Date('2026-10-09T08:00:00Z'));
    await redeem(issued.code, invited);
    // `redeemOnSignUp` stamps the wall clock; pin it to the account's day.
    await dataSource
      .getRepository(InviteRedemption)
      .update({ userId: invited }, { redeemedAt: new Date('2026-10-09T08:00:00Z') });
    await account('open@example.com', new Date('2026-10-09T09:00:00Z'));
    // Outside a three-day window, so in no bucket.
    await account('old@example.com', new Date('2026-09-01T00:00:00Z'));

    const days = await stats.daily(3, operator, NOW);

    expect(days.map((day) => day.date)).toEqual(['2026-10-07', '2026-10-08', '2026-10-09']);
    expect(days[0]).toMatchObject({ codesIssued: 3, signUpsBootstrap: 1, signUpsInvited: 0, signUpsOpen: 0 });
    expect(days[1]).toMatchObject({ codesIssued: 0, codesRedeemed: 0, signUpsInvited: 0, signUpsOpen: 0 });
    expect(days[2]).toMatchObject({ codesRedeemed: 1, signUpsInvited: 1, signUpsOpen: 1, signUpsBootstrap: 0 });
  });
});

describe('attribution by account', () => {
  it('maps each redeeming account to its code and leaves the rest out', async () => {
    const [issued] = await issue(1, { campaign: 'devs' });
    const invited = await account('invited@example.com', NOW);
    await redeem(issued.code, invited);
    const other = await account('other@example.com', NOW);

    const map = await attribution.forUsers([invited, other]);

    expect([...map.keys()]).toEqual([invited]);
    expect(map.get(invited)).toMatchObject({ inviteCodeId: issued.id, campaign: 'devs' });
  });

  it('answers an empty list without querying for nothing', async () => {
    expect((await attribution.forUsers([])).size).toBe(0);
  });
});
