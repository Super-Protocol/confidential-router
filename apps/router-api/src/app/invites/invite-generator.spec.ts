import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDataSource } from '../../../test/seed.js';
import { InviteCode } from '../db/entities/invite-code.entity.js';
import { looksLikeInviteCode, normaliseInviteCode } from './invite-code.js';
import { type GenerateInvitesRequest, generateInvites, invitesCsv } from './invite-generator.js';

let dataSource: DataSource;

beforeEach(async () => {
  dataSource = await createTestDataSource();
});

afterEach(async () => {
  await dataSource.destroy();
});

function request(overrides: Partial<GenerateInvitesRequest> = {}): GenerateInvitesRequest {
  return {
    count: 10,
    grantMicros: 100_000_000,
    campaign: 'launch-2026-10',
    maxRedemptions: 1,
    expiresAt: null,
    note: null,
    landingBaseUrl: 'https://router.superprotocol.com',
    ...overrides,
  };
}

describe('generateInvites', () => {
  it('writes the codes it returns, with the campaign’s terms on every row', async () => {
    const generated = await generateInvites(dataSource, request({ count: 5, expiresAt: new Date('2027-01-01') }));

    expect(generated).toHaveLength(5);
    const stored = await dataSource.getRepository(InviteCode).find();
    expect(stored).toHaveLength(5);
    for (const row of stored) {
      expect(row).toMatchObject({
        grantMicros: 100_000_000,
        campaign: 'launch-2026-10',
        maxRedemptions: 1,
        redemptionCount: 0,
      });
      expect(row.expiresAt?.toISOString()).toBe(new Date('2027-01-01').toISOString());
      expect(looksLikeInviteCode(row.code)).toBe(true);
    }
  });

  it('stores the normalised code and hands back the display form', async () => {
    const [generated] = await generateInvites(dataSource, request({ count: 1 }));
    const [stored] = await dataSource.getRepository(InviteCode).find();

    expect(generated.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(normaliseInviteCode(generated.code)).toBe(stored.code);
  });

  it('puts the stored code and the campaign in the URL the mailing sends', async () => {
    const [generated] = await generateInvites(dataSource, request({ count: 1 }));
    const [stored] = await dataSource.getRepository(InviteCode).find();

    const url = new URL(generated.url);
    expect(url.origin).toBe('https://router.superprotocol.com');
    expect(normaliseInviteCode(url.searchParams.get('invite') ?? '')).toBe(stored.code);
    expect(url.searchParams.get('utm_campaign')).toBe('launch-2026-10');
  });

  it('mints a campaign larger than one batch, all of them distinct', async () => {
    const generated = await generateInvites(dataSource, request({ count: 600 }));

    expect(new Set(generated.map((invite) => invite.code)).size).toBe(600);
    expect(await dataSource.getRepository(InviteCode).count()).toBe(600);
  });

  it('keeps two campaigns apart', async () => {
    await generateInvites(dataSource, request({ count: 3, campaign: 'launch-2026-10' }));
    await generateInvites(dataSource, request({ count: 4, campaign: 'launch-2026-11' }));

    expect(await dataSource.getRepository(InviteCode).countBy({ campaign: 'launch-2026-10' })).toBe(3);
    expect(await dataSource.getRepository(InviteCode).countBy({ campaign: 'launch-2026-11' })).toBe(4);
  });
});

describe('invitesCsv', () => {
  it('is the two columns the mailing tool reads, with a header', async () => {
    const generated = await generateInvites(dataSource, request({ count: 2 }));

    const rows = invitesCsv(generated).trimEnd().split('\r\n');
    expect(rows[0]).toBe('code,url');
    expect(rows).toHaveLength(3);
    for (const [index, row] of rows.slice(1).entries()) {
      // Quoted, because a URL with UTM parameters contains commas-free but the
      // writer quotes on need; either way the code has to be the first field.
      expect(row.startsWith(generated[index].code)).toBe(true);
      expect(row).toContain(generated[index].url);
    }
  });
});
