import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Catalog, createTestDataSource, seedCatalog, seedGeneration, testConfig } from '../../../test/seed.js';
import { LedgerService } from '../billing/ledger.service.js';
import { InviteCode } from '../db/entities/invite-code.entity.js';
import { generateInvites } from './invite-generator.js';
import { InviteStatsService } from './invite-stats.service.js';
import { InvitesService } from './invites.service.js';
import { NO_SIGN_UP_INVITE } from './sign-up-invite.js';

let dataSource: DataSource;
let stats: InviteStatsService;
let invites: InvitesService;

beforeEach(async () => {
  dataSource = await createTestDataSource();
  const config = testConfig();
  stats = new InviteStatsService(dataSource);
  invites = new InvitesService(dataSource, config, new LedgerService(dataSource, config));
});

afterEach(async () => {
  await dataSource.destroy();
});

async function issue(campaign: string, count: number): Promise<string[]> {
  await generateInvites(dataSource, {
    count,
    grantMicros: 100_000_000,
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

describe('a campaign nobody redeemed', () => {
  it('reports the codes it issued and nothing else', async () => {
    await issue('launch-2026-10', 5);

    expect(await stats.campaigns('launch-2026-10')).toEqual([
      {
        campaign: 'launch-2026-10',
        issued: 5,
        redeemed: 0,
        redemptionRate: 0,
        activated: 0,
        grantedMicros: 0,
      },
    ]);
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
      redemptionRate: 0.5,
      // The number the campaign is judged on: two sign-ups, one of which is a user.
      activated: 1,
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
      { campaign: 'never-ran', issued: 0, redeemed: 0, redemptionRate: 0, activated: 0, grantedMicros: 0 },
    ]);
  });
});
