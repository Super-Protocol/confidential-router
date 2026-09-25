import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager } from 'typeorm';
import { isUniqueViolation, LedgerService } from '../billing/index.js';
import { saltedHash } from '../common/salted-hash.js';
import { routerConfig } from '../config.js';
import { InviteCode } from '../db/entities/invite-code.entity.js';
import { InviteRedemption } from '../db/entities/invite-redemption.entity.js';
import { looksLikeInviteCode, normaliseInviteCode } from './invite-code.js';
import type { SignUpInvite } from './sign-up-invite.js';

/** Why a code cannot be redeemed. Never sent to an anonymous caller as-is. */
export type InviteUnusableReason = 'not_found' | 'expired' | 'exhausted' | 'disabled';

export type InviteLookup =
  | { valid: true; grantMicros: number; campaign: string }
  | { valid: false; reason: InviteUnusableReason };

export type InviteRedemptionOutcome =
  /**
   * Credited. `creditTransactionId` is the `grant` row in the ledger;
   * `redemptionId` is the `invite_redemptions` row, which is what the
   * `invite_redeemed` analytics event uses as its idempotency key (SUP-145).
   */
  | {
      status: 'granted';
      grantMicros: number;
      campaign: string;
      creditTransactionId: string;
      redemptionId: string;
    }
  /** The request carried no code. The overwhelmingly common case. */
  | { status: 'none' }
  | { status: 'refused'; reason: InviteUnusableReason | 'already_redeemed' | 'error' };

export interface RedeemOnSignUpInput {
  userId: string;
  workspaceId: string;
  invite: SignUpInvite;
}

/** The claim lost its race, or the code became unusable between read and write. */
class InviteClaimLostError extends Error {
  constructor(readonly reason: InviteUnusableReason) {
    super(`The invitation code is no longer redeemable: ${reason}.`);
    this.name = 'InviteClaimLostError';
  }
}

/**
 * Invitation codes: what a code is worth, and the one place it is spent.
 *
 * Redemption is deliberately not reachable from outside. It runs inside account
 * creation (see `sign-up-invite.ts`), which is what makes "one grant per account,
 * ever" a property of the system rather than of the client's good behaviour, and
 * it is written so that it cannot fail the sign-up that triggered it: every
 * outcome — including an unexpected one — comes back as an
 * {@link InviteRedemptionOutcome}, and the account exists either way.
 *
 * Three independent locks make a double grant impossible, and all three are in
 * the database rather than in this code:
 *
 *  1. the relative `UPDATE … WHERE redemptionCount < maxRedemptions`, so two
 *     sign-ups racing for the last seat resolve to exactly one winner without a
 *     row lock — which SQLite does not have;
 *  2. the unique index on `invite_redemptions.userId`, which is the one-per-account
 *     policy;
 *  3. the unique index on `credit_transactions.idempotencyKey`, keyed
 *     `invite:<codeId>:<userId>`, which refuses the credit even if the first two
 *     were somehow bypassed.
 *
 * All three run in one transaction, so losing any of them leaves nothing behind.
 */
@Injectable()
export class InvitesService {
  private readonly logger = new Logger(InvitesService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(routerConfig.KEY) private readonly config: ConfigType<typeof routerConfig>,
    private readonly ledger: LedgerService,
  ) {}

  /**
   * What a code is worth, before anyone commits to anything — the landing page's
   * "your $100 credit is ready".
   *
   * The reason is typed here because operators and the CLI need to tell an
   * expired code from a wrong one. The public endpoint collapses every unusable
   * outcome into one answer; see `InvitesController`.
   */
  async lookup(raw: string, now: Date = new Date()): Promise<InviteLookup> {
    const code = normaliseInviteCode(raw);
    if (!looksLikeInviteCode(code)) {
      return { valid: false, reason: 'not_found' };
    }
    const found = await this.dataSource.getRepository(InviteCode).findOne({ where: { code } });
    if (!found) {
      return { valid: false, reason: 'not_found' };
    }
    const unusable = unusableReason(found, now);
    return unusable
      ? { valid: false, reason: unusable }
      : { valid: true, grantMicros: found.grantMicros, campaign: found.campaign };
  }

  /**
   * Spends the code the sign-up request carried, if it carried one.
   *
   * Never throws. A missing, malformed, spent or already-redeemed code leaves the
   * brand-new account exactly as it was — with no credit — because the
   * alternative is refusing a registration over a mailing-list mistake.
   */
  async redeemOnSignUp(input: RedeemOnSignUpInput): Promise<InviteRedemptionOutcome> {
    if (!input.invite.code) {
      return { status: 'none' };
    }
    try {
      return await this.redeem(input);
    } catch (error) {
      // Includes the unique-index violations that are the guarantee working: two
      // concurrent redemptions, or a user who already has a grant.
      const reason = isUniqueViolation(error) ? 'already_redeemed' : 'error';
      if (reason === 'error') {
        this.logger.error(
          `Invitation redemption failed for user ${input.userId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return { status: 'refused', reason };
    }
  }

  /** The viewer's grant, for the console to confirm the credit landed. */
  redemptionOf(userId: string): Promise<InviteRedemption | null> {
    return this.dataSource.getRepository(InviteRedemption).findOne({
      where: { userId },
      relations: { inviteCode: true },
    });
  }

  private async redeem(input: RedeemOnSignUpInput): Promise<InviteRedemptionOutcome> {
    const now = new Date();
    const code = normaliseInviteCode(input.invite.code ?? '');
    if (!looksLikeInviteCode(code)) {
      return { status: 'refused', reason: 'not_found' };
    }

    const invite = await this.dataSource.getRepository(InviteCode).findOne({ where: { code } });
    if (!invite) {
      return { status: 'refused', reason: 'not_found' };
    }
    // Read-time checks so the common refusals get their real reason; the
    // transaction below re-checks all of them, and that re-check is the one that
    // counts.
    const unusable = unusableReason(invite, now);
    if (unusable) {
      return { status: 'refused', reason: unusable };
    }

    try {
      return await this.ledger.transaction(input.workspaceId, (manager) =>
        this.grant(manager, invite, { ...input, now }),
      );
    } catch (error) {
      if (error instanceof InviteClaimLostError) {
        return { status: 'refused', reason: error.reason };
      }
      throw error;
    }
  }

  /**
   * The whole redemption, in the caller's transaction: claim a seat, credit the
   * workspace, record that it happened.
   *
   * `invite` is the row read before the transaction opened, and its terms —
   * `grantMicros`, `campaign` — are used as read. That is safe because a code's
   * terms are written once, at generation: nothing in this service, the console or
   * the CLI updates them. Only the mutable parts (`redemptionCount`, `disabledAt`,
   * `expiresAt`) can change under us, and those are exactly what `claimSeat`
   * re-checks inside the transaction.
   */
  private async grant(
    manager: EntityManager,
    invite: InviteCode,
    input: RedeemOnSignUpInput & { now: Date },
  ): Promise<InviteRedemptionOutcome> {
    await claimSeat(manager, invite, input.now);

    const entry = await this.ledger.appendWithin(manager, {
      workspaceId: input.workspaceId,
      kind: 'grant',
      amountMicros: invite.grantMicros,
      // The campaign, so the Credits screen can name where the credit came from
      // and a campaign's spend is answerable from the ledger alone.
      reference: invite.campaign,
      description: `Invitation credit · ${invite.campaign}`,
      idempotencyKey: `invite:${invite.id}:${input.userId}`,
    });

    const redemptionId = randomUUID();
    await manager.insert(InviteRedemption, {
      id: redemptionId,
      inviteCodeId: invite.id,
      userId: input.userId,
      workspaceId: input.workspaceId,
      creditTransactionId: entry.transaction.id,
      ipHash: this.fingerprint(input.invite.ip),
      userAgentHash: this.fingerprint(input.invite.userAgent),
      redeemedAt: input.now,
    });

    this.logger.log(
      `Invitation ${invite.campaign} redeemed by user ${input.userId}: ${invite.grantMicros} micro-USD credited.`,
    );
    return {
      status: 'granted',
      grantMicros: invite.grantMicros,
      campaign: invite.campaign,
      creditTransactionId: entry.transaction.id,
      redemptionId,
    };
  }

  private fingerprint(value: string | null): string | null {
    return value ? saltedHash(this.config.auth.secret, value) : null;
  }
}

/**
 * Takes one of the code's seats, or refuses.
 *
 * One relative `UPDATE` whose `WHERE` carries every condition: the seat count,
 * the disabled flag and the expiry. Nothing is read first, so there is no window
 * between the decision and the write — two transactions on the last seat both
 * issue this statement and exactly one reports a row affected. The same shape as
 * `LedgerService.append`, and for the same reason: it is correct on SQLite, which
 * has neither row locks nor `SELECT … FOR UPDATE`.
 */
async function claimSeat(manager: EntityManager, invite: InviteCode, now: Date): Promise<void> {
  const column = (name: string): string => manager.connection.driver.escape(name);
  const result = await manager
    .createQueryBuilder()
    .update(InviteCode)
    .set({ redemptionCount: () => `${column('redemptionCount')} + 1` })
    .where('id = :id', { id: invite.id })
    .andWhere(`${column('redemptionCount')} < ${column('maxRedemptions')}`)
    .andWhere(`${column('disabledAt')} IS NULL`)
    .andWhere(`(${column('expiresAt')} IS NULL OR ${column('expiresAt')} > :now)`, { now: now.getTime() })
    .execute();

  if (!result.affected) {
    // Re-read inside the transaction to say *why*: the caller's copy of the row
    // is the one that passed the read-time check, so asking it would always
    // answer "usable".
    const current = await manager.findOne(InviteCode, { where: { id: invite.id } });
    throw new InviteClaimLostError(current ? (unusableReason(current, now) ?? 'exhausted') : 'not_found');
  }
}

/**
 * Why the code cannot be used, or `null`.
 *
 * Most deliberate cause first: an operator who disabled a code wants to see
 * "disabled" even if it had also expired.
 */
function unusableReason(invite: InviteCode, now: Date): InviteUnusableReason | null {
  if (invite.disabledAt) {
    return 'disabled';
  }
  if (invite.expiresAt && invite.expiresAt.getTime() <= now.getTime()) {
    return 'expired';
  }
  if (invite.redemptionCount >= invite.maxRedemptions) {
    return 'exhausted';
  }
  return null;
}
