import { randomUUID } from 'node:crypto';
import { APIError } from 'better-auth/api';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDataSource, testConfig } from '../../../test/seed.js';
import { LedgerService } from '../billing/ledger.service.js';
import { InviteCode } from '../db/entities/invite-code.entity.js';
import { formatInviteCode, mintInviteCode } from '../invites/invite-code.js';
import { InvitesService } from '../invites/invites.service.js';
import { NO_SIGN_UP_INVITE, type SignUpInvite } from '../invites/sign-up-invite.js';
import { SignUpGate } from './sign-up-gate.service.js';

/**
 * The gate, on its own.
 *
 * It is one decision — may this account exist — and it is worth testing away
 * from Better Auth because every interesting case is about *which* refusal comes
 * out, and the wiring that carries it is the same for all of them.
 */

let dataSource: DataSource;
let invites: InvitesService;

beforeEach(async () => {
  dataSource = await createTestDataSource();
  const config = testConfig();
  invites = new InvitesService(dataSource, config, new LedgerService(dataSource, config));
});

afterEach(async () => {
  await dataSource.destroy();
});

function gate(required: boolean): SignUpGate {
  return new SignUpGate(testConfig(required ? { CR_API_AUTH__REQUIRE_INVITE_FOR_SIGN_UP: 'true' } : {}), invites);
}

interface SeedCode {
  redemptionCount?: number;
  expiresAt?: Date | null;
  disabledAt?: Date | null;
}

async function seedCode(seed: SeedCode = {}): Promise<InviteCode> {
  const values = {
    id: randomUUID(),
    code: mintInviteCode(),
    grantMicros: 100_000_000,
    campaign: 'launch-2026-10',
    maxRedemptions: 1,
    redemptionCount: seed.redemptionCount ?? 0,
    expiresAt: seed.expiresAt ?? null,
    disabledAt: seed.disabledAt ?? null,
    note: null,
    createdAt: new Date(),
  };
  await dataSource.getRepository(InviteCode).insert(values);
  return dataSource.getRepository(InviteCode).create(values);
}

function carrying(code: string | null): SignUpInvite {
  return { ...NO_SIGN_UP_INVITE, code };
}

/** The `code` the console switches on, from whatever the gate threw. */
async function refusalOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error, 'the gate admitted a sign-up it should have refused').toBeInstanceOf(APIError);
  return (error as APIError).body?.code as string;
}

describe('a deployment that does not require an invitation', () => {
  it('admits every sign-up, code or no code, good or spent', async () => {
    const usable = await seedCode();
    const spent = await seedCode({ redemptionCount: 1 });

    await expect(gate(false).admit(carrying(null), false)).resolves.toBeUndefined();
    await expect(gate(false).admit(carrying(usable.code), false)).resolves.toBeUndefined();
    await expect(gate(false).admit(carrying(spent.code), false)).resolves.toBeUndefined();
  });
});

describe('a deployment that requires an invitation', () => {
  it('admits a usable code, and spends nothing doing it', async () => {
    const code = await seedCode();

    await expect(gate(true).admit(carrying(code.code), false)).resolves.toBeUndefined();

    // The seat is still there. It is claimed by the grant that follows the
    // insert, which is the only place a write can happen — see `SignUpGate`.
    expect(await dataSource.getRepository(InviteCode).findOneByOrFail({ id: code.id })).toMatchObject({
      redemptionCount: 0,
    });
  });

  it('accepts the code in whatever shape it arrived, as the redemption will', async () => {
    const code = await seedCode();

    await expect(gate(true).admit(carrying(formatInviteCode(code.code).toLowerCase()), false)).resolves.toBeUndefined();
  });

  it('refuses a request with no code as `invite_required`', async () => {
    expect(await refusalOf(gate(true).admit(carrying(null), false))).toBe('invite_required');
  });

  it('refuses a spent code as `invite_already_claimed`', async () => {
    const code = await seedCode({ redemptionCount: 1 });

    expect(await refusalOf(gate(true).admit(carrying(code.code), false))).toBe('invite_already_claimed');
  });

  it('gives expired, withdrawn and never-issued codes the same answer', async () => {
    const expired = await seedCode({ expiresAt: new Date('2020-01-01T00:00:00Z') });
    const disabled = await seedCode({ disabledAt: new Date() });

    for (const candidate of [expired.code, disabled.code, mintInviteCode(), 'not-a-code']) {
      expect(await refusalOf(gate(true).admit(carrying(candidate), false)), candidate).toBe(
        'invite_expired_or_unknown',
      );
    }
  });

  it('refuses with a 403, so a session that expired and a sign-up that was turned away do not look alike', async () => {
    const error = await gate(true)
      .admit(carrying(null), false)
      .then(
        () => null,
        (caught: unknown) => caught as APIError,
      );

    expect(error?.statusCode).toBe(403);
    expect(error?.body?.message).toMatch(/invitation/i);
  });

  it('lets the deployment’s own bootstrap token through, which no invitation could cover', async () => {
    await expect(gate(true).admit(carrying(null), true)).resolves.toBeUndefined();
  });
});
