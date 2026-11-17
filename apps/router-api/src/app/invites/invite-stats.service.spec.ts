import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Catalog, createTestDataSource, seedCatalog, seedGeneration, testConfig } from '../../../test/seed.js';
import { type LedgerEntry, LedgerService } from '../billing/ledger.service.js';
import { InviteCarriedRedemption } from '../db/entities/invite-carried-redemption.entity.js';
import { InviteCode } from '../db/entities/invite-code.entity.js';
import { WorkspaceMember, type WorkspaceRole } from '../db/entities/workspace-member.entity.js';
import { generateInvites } from './invite-generator.js';
import { InviteStatsService } from './invite-stats.service.js';
import { InvitesService } from './invites.service.js';
import { NO_SIGN_UP_INVITE } from './sign-up-invite.js';

let dataSource: DataSource;
let stats: InviteStatsService;
let invites: InvitesService;
let ledger: LedgerService;

beforeEach(async () => {
  dataSource = await createTestDataSource();
  const config = testConfig();
  stats = new InviteStatsService(dataSource);
  ledger = new LedgerService(dataSource, config);
  invites = new InvitesService(dataSource, config, ledger);
  // Better Auth owns `user` and creates it with its own migration, which a unit
  // test does not run; `totals()` counts it, and matching a carried redemption's
  // address to an account reads it, so the columns `User` maps have to exist.
  await dataSource.query(
    'CREATE TABLE "user" ("id" varchar PRIMARY KEY, "email" varchar NOT NULL, "name" varchar NOT NULL, "image" varchar, "createdAt" date NOT NULL)',
  );
});

afterEach(async () => {
  await dataSource.destroy();
});

async function issue(campaign: string, count: number, grantMicros = 100_000_000): Promise<string[]> {
  await generateInvites(dataSource, {
    count,
    grantMicros,
    campaign,
    maxRedemptions: 1,
    expiresAt: null,
    note: null,
    landingBaseUrl: 'https://router.superprotocol.com',
  });
  const rows = await dataSource.getRepository(InviteCode).findBy({ campaign });
  return rows.map((row) => row.code);
}

/** Fixes a campaign's generation time, so ordering is not a race with the clock. */
async function stamp(campaign: string, createdAt: Date): Promise<void> {
  await dataSource.getRepository(InviteCode).update({ campaign }, { createdAt });
}

/** An account on this deployment, as Better Auth would have written it. */
async function account(email: string, createdAt: Date = new Date('2026-10-02T00:00:00Z')): Promise<string> {
  const id = randomUUID();
  await dataSource.query('INSERT INTO "user" ("id", "email", "name", "createdAt") VALUES (?, ?, ?, ?)', [
    id,
    email,
    '',
    createdAt.toISOString(),
  ]);
  return id;
}

/**
 * A redemption a codes CSV import carried over (SUP-272), written the way
 * `InviteCodesTransferService.apply` writes one: the row names an address and a
 * date, and the code's `redemptionCount` is what makes it unusable here.
 */
async function carry(code: string, email: string | null, redeemedAt: Date): Promise<void> {
  const row = await dataSource.getRepository(InviteCode).findOneByOrFail({ code: code.replaceAll('-', '') });
  await dataSource.getRepository(InviteCarriedRedemption).insert({
    id: randomUUID(),
    inviteCodeId: row.id,
    email,
    redeemedAt,
    importedAt: new Date('2026-10-17T00:00:00Z'),
  });
  await dataSource.getRepository(InviteCode).update({ id: row.id }, { redemptionCount: row.redemptionCount + 1 });
}

/** Puts an account in a workspace, so a carried redeemer has one to have used. */
async function own(userId: string, workspaceId: string, role: WorkspaceRole = 'owner'): Promise<void> {
  await dataSource
    .getRepository(WorkspaceMember)
    .insert({ workspaceId, userId, role, createdAt: new Date('2026-10-02T00:00:00Z') });
}

/** One sign-up: its own workspace, redeeming one code. */
async function signUpWith(code: string): Promise<Catalog> {
  const catalog = await seedCatalog(dataSource);
  const outcome = await invites.redeemOnSignUp({
    userId: randomUUID(),
    workspaceId: catalog.workspaceId,
    invite: { ...NO_SIGN_UP_INVITE, code },
  });
  expect(outcome.status).toBe('granted');
  return catalog;
}

/**
 * Credit an operator moved by hand: an `adjustment`, the one kind the ledger
 * lets a human write in either direction.
 */
async function adjust(workspaceId: string, amountMicros: number, description: string): Promise<LedgerEntry> {
  return ledger.record({
    workspaceId,
    kind: 'adjustment',
    amountMicros,
    reference: 'operator',
    description,
    idempotencyKey: `adjustment:${randomUUID()}`,
  });
}

describe('a campaign nobody redeemed', () => {
  /**
   * The state that made `grantedMicros` read as a face value on the console
   * (SUP-390): fifty codes worth $100 each, nothing paid out yet. Nothing has
   * been granted, and each code is still worth what it was issued for — two
   * facts the campaign row has to be able to state at once.
   */
  it('reports the codes it issued, their face value, and nothing paid out', async () => {
    await issue('launch-2026-10', 5);

    expect(await stats.campaigns('launch-2026-10')).toEqual([
      {
        campaign: 'launch-2026-10',
        issued: 5,
        redeemed: 0,
        carried: 0,
        redemptionRate: 0,
        activated: 0,
        codeGrantMicrosMin: 100_000_000,
        codeGrantMicrosMax: 100_000_000,
        grantedMicros: 0,
      },
    ]);
  });
});

describe('a campaign tag that collects two batches', () => {
  it('reports the face value as the span the batches cover', async () => {
    await issue('launch-2026-10', 2, 25_000_000);
    await issue('launch-2026-10', 3, 100_000_000);

    expect((await stats.campaigns('launch-2026-10'))[0]).toMatchObject({
      issued: 5,
      codeGrantMicrosMin: 25_000_000,
      codeGrantMicrosMax: 100_000_000,
      grantedMicros: 0,
    });
  });

  it('pays out what the redeemed code was worth, not the span', async () => {
    const cheap = await issue('launch-2026-10', 1, 25_000_000);
    await issue('launch-2026-10', 1, 100_000_000);
    await signUpWith(cheap[0]);

    expect((await stats.campaigns('launch-2026-10'))[0]).toMatchObject({
      redeemed: 1,
      codeGrantMicrosMin: 25_000_000,
      codeGrantMicrosMax: 100_000_000,
      grantedMicros: 25_000_000,
    });
  });
});

describe('a campaign in flight', () => {
  it('counts redemptions, the rate, and only the accounts that actually sent something', async () => {
    const codes = await issue('launch-2026-10', 4);
    const sent = await signUpWith(codes[0]);
    await signUpWith(codes[1]);
    await seedGeneration(dataSource, sent, { createdAt: new Date('2026-10-02T10:00:00Z') });

    const [campaign] = await stats.campaigns('launch-2026-10');

    expect(campaign).toEqual({
      campaign: 'launch-2026-10',
      issued: 4,
      redeemed: 2,
      carried: 0,
      redemptionRate: 0.5,
      // The number the campaign is judged on: two sign-ups, one of which is a user.
      activated: 1,
      codeGrantMicrosMin: 100_000_000,
      codeGrantMicrosMax: 100_000_000,
      grantedMicros: 200_000_000,
    });
  });

  it('counts an account once however many requests it sent', async () => {
    const codes = await issue('launch-2026-10', 1);
    const sent = await signUpWith(codes[0]);
    await seedGeneration(dataSource, sent, { createdAt: new Date('2026-10-02T10:00:00Z') });
    await seedGeneration(dataSource, sent, { createdAt: new Date('2026-10-02T11:00:00Z') });

    expect((await stats.campaigns('launch-2026-10'))[0]).toMatchObject({ redeemed: 1, activated: 1 });
  });
});

describe('credit that did not come from an invitation', () => {
  /**
   * Invitation statistics measure the *campaign*, not the balance (SUP-398).
   *
   * `grantedMicros` is `SUM(code.grantMicros)` over the redemptions, so what a
   * campaign handed out is fixed the moment its codes are minted: an operator
   * topping an invited account up afterwards, or correcting it down, is credit
   * the campaign never promised. If those entries leaked in, every number the
   * launch is judged on would drift with support work that has nothing to do
   * with it — and the drift would be invisible, because the figure would still
   * look like a campaign total.
   *
   * The structure already guarantees it; these pin it so a later rewrite of
   * `sumGranted` towards the ledger cannot quietly change what the number means.
   */
  it('leaves a campaign untouched when an operator adjusts an invited balance', async () => {
    const codes = await issue('launch-2026-10', 4);
    const invited = await signUpWith(codes[0]);
    await signUpWith(codes[1]);
    const before = await stats.campaigns('launch-2026-10');

    await adjust(invited.workspaceId, 50_000_000, 'SUP-389: topped up after the verification grant');
    await adjust(invited.workspaceId, -20_000_000, 'SUP-389: clawing part of it back');

    expect(await stats.campaigns('launch-2026-10')).toEqual(before);
    expect(before[0]).toMatchObject({ redeemed: 2, grantedMicros: 200_000_000 });
  });

  it('leaves the deployment totals untouched too', async () => {
    const codes = await issue('launch-2026-10', 2);
    const invited = await signUpWith(codes[0]);
    const before = await stats.totals();

    await adjust(invited.workspaceId, 100_000_000, 'operator top-up');

    expect(await stats.totals()).toEqual(before);
    expect(before.grantedMicros).toBe(100_000_000);
  });

  it('counts nothing for an account that never redeemed a code, however it was credited', async () => {
    await issue('launch-2026-10', 2);
    const uninvited = await seedCatalog(dataSource);

    await adjust(uninvited.workspaceId, 100_000_000, 'SUP-408: signed up without a code');

    expect((await stats.campaigns('launch-2026-10'))[0]).toMatchObject({ redeemed: 0, grantedMicros: 0 });
    expect(await stats.totals()).toMatchObject({ redeemed: 0, grantedMicros: 0 });
  });

  it('moved the balance it was supposed to move, so the invariance is not an inert test', async () => {
    const codes = await issue('launch-2026-10', 1);
    const invited = await signUpWith(codes[0]);

    const entry = await adjust(invited.workspaceId, 50_000_000, 'operator top-up');

    // The redemption grant plus the adjustment, exact to the micro.
    expect(entry.balanceMicros).toBe(150_000_000);
  });
});

describe('several campaigns', () => {
  it('keeps their numbers separate, and lists them newest first', async () => {
    const october = await issue('launch-2026-10', 2);
    const november = await issue('launch-2026-11', 3);
    // Explicit timestamps: `generateInvites` stamps a campaign with the clock,
    // and two calls a millisecond apart would leave the ordering to the tie-break
    // rather than to the thing under test.
    await stamp('launch-2026-10', new Date('2026-10-01T00:00:00Z'));
    await stamp('launch-2026-11', new Date('2026-11-01T00:00:00Z'));
    await signUpWith(october[0]);
    await signUpWith(november[0]);
    await signUpWith(november[1]);

    const all = await stats.campaigns();

    expect(all.map((entry) => entry.campaign)).toEqual(['launch-2026-11', 'launch-2026-10']);
    expect(all).toMatchObject([
      { campaign: 'launch-2026-11', issued: 3, redeemed: 2 },
      { campaign: 'launch-2026-10', issued: 2, redeemed: 1 },
    ]);
  });

  it('breaks a tie on the campaign name, so the list is stable', async () => {
    const at = new Date('2026-10-01T00:00:00Z');
    await issue('launch-b', 1);
    await issue('launch-a', 1);
    await stamp('launch-a', at);
    await stamp('launch-b', at);

    expect((await stats.campaigns()).map((entry) => entry.campaign)).toEqual(['launch-a', 'launch-b']);
  });

  it('reports nothing at all before any code is generated', async () => {
    expect(await stats.campaigns()).toEqual([]);
  });

  it('reports an unknown campaign as an empty one rather than failing', async () => {
    expect(await stats.campaigns('never-ran')).toEqual([
      {
        campaign: 'never-ran',
        issued: 0,
        redeemed: 0,
        carried: 0,
        redemptionRate: 0,
        activated: 0,
        codeGrantMicrosMin: 0,
        codeGrantMicrosMax: 0,
        grantedMicros: 0,
      },
    ]);
  });
});

/**
 * SUP-396. Every code on production arrived through a CSV import, because the
 * deployment has been rebuilt and the codes restored from an off-cluster export;
 * counting only `invite_redemptions` reported a campaign people had redeemed as
 * `Redeemed 0 · Rate 0%` on the one screen the owner watches.
 */
describe('a campaign whose redemptions were carried over by an import', () => {
  it('counts them as redeemed, and says how many came from the file', async () => {
    const codes = await issue('launch-2026-10', 4);
    await carry(codes[0], 'early@example.com', new Date('2026-10-14T10:00:00Z'));
    await carry(codes[1], 'later@example.com', new Date('2026-10-15T10:00:00Z'));

    expect((await stats.campaigns('launch-2026-10'))[0]).toMatchObject({
      issued: 4,
      redeemed: 2,
      carried: 2,
      redemptionRate: 0.5,
    });
  });

  it('leaves grantedMicros alone, because another ledger paid for them', async () => {
    const codes = await issue('launch-2026-10', 2);
    await carry(codes[0], 'early@example.com', new Date('2026-10-14T10:00:00Z'));

    expect((await stats.campaigns('launch-2026-10'))[0]).toMatchObject({ redeemed: 1, grantedMicros: 0 });
  });

  it('adds them to the redemptions made here rather than replacing them', async () => {
    const codes = await issue('launch-2026-10', 4);
    await signUpWith(codes[0]);
    await carry(codes[1], 'imported@example.com', new Date('2026-10-14T10:00:00Z'));

    expect((await stats.campaigns('launch-2026-10'))[0]).toMatchObject({
      redeemed: 2,
      carried: 1,
      redemptionRate: 0.5,
      // One grant on this ledger: the live redemption's.
      grantedMicros: 100_000_000,
    });
  });

  it('activates a carried redeemer once their account here has sent something', async () => {
    const codes = await issue('launch-2026-10', 2);
    await carry(codes[0], 'imported@example.com', new Date('2026-10-14T10:00:00Z'));
    const catalog = await seedCatalog(dataSource);
    await own(await account('imported@example.com'), catalog.workspaceId);
    await seedGeneration(dataSource, catalog, { createdAt: new Date('2026-10-18T10:00:00Z') });

    expect((await stats.campaigns('launch-2026-10'))[0]).toMatchObject({ redeemed: 1, carried: 1, activated: 1 });
  });

  it('cannot activate an address with no account here, and does not pretend otherwise', async () => {
    const codes = await issue('launch-2026-10', 2);
    await carry(codes[0], 'gone@example.com', new Date('2026-10-14T10:00:00Z'));
    await carry(codes[1], null, new Date('2026-10-14T11:00:00Z'));

    expect((await stats.campaigns('launch-2026-10'))[0]).toMatchObject({ redeemed: 2, carried: 2, activated: 0 });
  });

  /**
   * A live redemption names one workspace, so it could never do this; a carried
   * one is matched to an *account*, and `workspace_members` exists so that team
   * workspaces stay an additive change (ADR-004 §5). Counting workspaces rather
   * than redemptions would print `activated` larger than `redeemed` the day they
   * land — on the screen this issue is about.
   */
  it('counts a carried redeemer once however many workspaces they belong to', async () => {
    const codes = await issue('launch-2026-10', 2);
    await carry(codes[0], 'imported@example.com', new Date('2026-10-14T10:00:00Z'));
    const redeemer = await account('imported@example.com');
    for (const name of ['personal', 'team']) {
      const workspace = await seedCatalog(dataSource);
      await own(redeemer, workspace.workspaceId, name === 'personal' ? 'owner' : 'member');
      await seedGeneration(dataSource, workspace, { createdAt: new Date('2026-10-18T10:00:00Z') });
    }

    expect((await stats.campaigns('launch-2026-10'))[0]).toMatchObject({ redeemed: 1, carried: 1, activated: 1 });
  });

  it('never reports more activations than redemptions, mixing live and carried redeemers', async () => {
    const codes = await issue('launch-2026-10', 2);
    const sent = await signUpWith(codes[0]);
    await seedGeneration(dataSource, sent, { createdAt: new Date('2026-10-18T10:00:00Z') });
    await carry(codes[1], 'imported@example.com', new Date('2026-10-14T10:00:00Z'));
    const redeemer = await account('imported@example.com');
    for (const _ of [0, 1]) {
      const workspace = await seedCatalog(dataSource);
      await own(redeemer, workspace.workspaceId);
      await seedGeneration(dataSource, workspace, { createdAt: new Date('2026-10-18T11:00:00Z') });
    }

    const [campaign] = await stats.campaigns('launch-2026-10');

    // Three busy workspaces, two redemptions: counting workspaces would say 3.
    expect(campaign).toMatchObject({ redeemed: 2, carried: 1, activated: 2 });
    expect(campaign.activated).toBeLessThanOrEqual(campaign.redeemed);
  });
});

describe('the deployment-wide totals and the daily series, with carried redemptions', () => {
  it('counts carried redemptions in the totals and keeps the credit live-only', async () => {
    const codes = await issue('launch-2026-10', 4);
    await signUpWith(codes[0]);
    await carry(codes[1], 'imported@example.com', new Date('2026-10-14T10:00:00Z'));

    expect(await stats.totals()).toMatchObject({
      issued: 4,
      redeemed: 2,
      carried: 1,
      redemptionRate: 0.5,
      grantedMicros: 100_000_000,
    });
  });

  it('buckets a carried redemption on the day it happened, not the day it was imported', async () => {
    const codes = await issue('launch-2026-10', 2);
    await carry(codes[0], 'imported@example.com', new Date('2026-10-17T10:00:00Z'));
    // Before the window: present in the totals, in no bucket.
    await carry(codes[1], 'older@example.com', new Date('2026-09-01T10:00:00Z'));

    const days = await stats.daily(3, null, new Date('2026-10-19T12:00:00Z'));

    expect(days.map((day) => [day.date, day.codesRedeemed])).toEqual([
      ['2026-10-17', 1],
      ['2026-10-18', 0],
      ['2026-10-19', 0],
    ]);
  });
});
