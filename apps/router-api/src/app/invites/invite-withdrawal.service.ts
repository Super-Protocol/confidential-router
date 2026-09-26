import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager, type SelectQueryBuilder } from 'typeorm';
import { InviteCode } from '../db/entities/invite-code.entity.js';
import { formatInviteCode, looksLikeInviteCode, normaliseInviteCode } from './invite-code.js';

/**
 * The kill switch: a mailed code stops granting credit, or starts again.
 *
 * `disabledAt` was built into the claim from the start — `claimSeat` re-checks it
 * inside the redemption transaction — but nothing ever wrote it, so a code that
 * leaked could not be withdrawn (SUP-159). This is the writer.
 *
 * **It cannot take back a grant that has already been made, by construction.**
 * `disabledAt` is read at redemption time and nowhere else: no balance, no
 * `credit_transactions` row and no `invite_redemptions` row is touched here, so
 * withdrawing a campaign mid-flight stops the *next* sign-up and leaves every
 * account that already redeemed exactly as it was. That is the property SUP-148
 * asked for, and `invite-withdrawal.service.spec.ts` is where it is pinned.
 *
 * Shaped like {@link InviteStatsService} rather than like {@link InvitesService}:
 * a `DataSource` and nothing else, so the CLI can `new` it with a bare connection
 * while Nest injects the same class into the operator mutation. One
 * implementation behind both surfaces — the alternative was the CLI's `UPDATE`
 * and the resolver's drifting apart.
 */
@Injectable()
export class InviteWithdrawalService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Withdraws the codes the request names.
   *
   * Idempotent: a code that is already withdrawn is reported, not re-stamped, so
   * running the command twice does not move the timestamp that says when the
   * leak was closed.
   */
  async withdraw(request: InviteWithdrawalRequest, now: Date = new Date()): Promise<InviteWithdrawal> {
    const target = targetOf(request);
    return this.dataSource.transaction(async (manager) => {
      const [matched, alreadyWithdrawn] = await this.census(manager, target);
      const withdrawn = await this.stamp(manager, target, now);
      return {
        target: nameOf(target),
        matched,
        withdrawn,
        alreadyWithdrawn,
        // Whatever the target matched and neither branch above accounts for is a
        // code `--unspent-only` deliberately left alone. Derived rather than
        // counted, so the three numbers always add up to `matched` even if a
        // redemption commits between the census and the `UPDATE`.
        spent: Math.max(matched - alreadyWithdrawn - withdrawn, 0),
      };
    });
  }

  /**
   * Puts withdrawn codes back into circulation — the undo for a mistyped
   * `--campaign`.
   *
   * It ships with the kill switch rather than after it because on a frozen
   * cluster there is no `psql` to undo with: without this, one wrong flag retires
   * a whole mailing and the only remedy is generating and re-mailing it.
   *
   * A code that expired or ran out of seats while it was withdrawn stays
   * unusable — this clears the withdrawal and nothing else.
   */
  async restore(request: InviteCodeSelector): Promise<InviteRestoration> {
    const target = targetOf({ ...request, unspentOnly: false });
    return this.dataSource.transaction(async (manager) => {
      const [matched, withdrawn] = await this.census(manager, target);
      const restored = await this.clear(manager, target);
      return { target: nameOf(target), matched, restored, alreadyUsable: matched - withdrawn };
    });
  }

  /** How many codes the target names, and how many of those are already withdrawn. */
  private async census(manager: EntityManager, target: Target): Promise<[matched: number, withdrawn: number]> {
    const quote = quoter(manager);
    const matching = (): SelectQueryBuilder<InviteCode> =>
      manager.createQueryBuilder(InviteCode, 'invite').where(targetSql(target, quote), parametersOf(target));

    return [
      await matching().getCount(),
      await matching()
        .andWhere(`${quote('disabledAt')} IS NOT NULL`)
        .getCount(),
    ];
  }

  private async stamp(manager: EntityManager, target: Target, now: Date): Promise<number> {
    const quote = quoter(manager);
    const update = manager
      .createQueryBuilder()
      .update(InviteCode)
      .set({ disabledAt: now })
      .where(targetSql(target, quote), parametersOf(target))
      // Already-withdrawn rows are excluded rather than overwritten: the
      // timestamp is when the code was taken out of circulation, and a second
      // run of the same command must not rewrite that.
      .andWhere(`${quote('disabledAt')} IS NULL`);

    if (target.unspentOnly) {
      update.andWhere(`${quote('redemptionCount')} < ${quote('maxRedemptions')}`);
    }
    return (await update.execute()).affected ?? 0;
  }

  private async clear(manager: EntityManager, target: Target): Promise<number> {
    const quote = quoter(manager);
    const result = await manager
      .createQueryBuilder()
      .update(InviteCode)
      .set({ disabledAt: null })
      .where(targetSql(target, quote), parametersOf(target))
      .andWhere(`${quote('disabledAt')} IS NOT NULL`)
      .execute();
    return result.affected ?? 0;
  }
}

/** Which codes to act on. Exactly one of `code` and `campaign`. */
export interface InviteCodeSelector {
  /** One code, in any spelling the invitation carried: case and separators are normalised. */
  code?: string | null;
  /** Every code of one campaign tag. */
  campaign?: string | null;
}

export interface InviteWithdrawalRequest extends InviteCodeSelector {
  /**
   * Leave codes whose every seat is already taken alone.
   *
   * Cosmetic rather than protective — withdrawing a spent code cannot claw its
   * grant back either — but it keeps `disabledAt` meaning "an operator retired
   * this", so a campaign's disabled count stays readable afterwards.
   */
  unspentOnly?: boolean;
}

/** The four numbers a withdrawal reports. They add up to {@link matched}. */
export interface InviteWithdrawal {
  /** What the request named, normalised — the display form of a code, or the tag. */
  target: string;
  /** Codes the target matched, whatever their state. Zero means there is no such code or campaign. */
  matched: number;
  /** Codes this call withdrew. */
  withdrawn: number;
  /** Codes that were already withdrawn, and were left with their original timestamp. */
  alreadyWithdrawn: number;
  /** Codes left in circulation because every seat is spent. Only `unspentOnly` produces these. */
  spent: number;
}

export interface InviteRestoration {
  target: string;
  matched: number;
  /** Codes this call put back into circulation. */
  restored: number;
  /** Codes the target matched that were never withdrawn. */
  alreadyUsable: number;
}

/** The request named neither target, or both, or something that cannot be a code. */
export class InviteTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InviteTargetError';
  }
}

type Target =
  | { code: string; campaign?: undefined; unspentOnly: boolean }
  | { code?: undefined; campaign: string; unspentOnly: boolean };

/**
 * One line the operator reads back — what the CLI prints, and what the mutation
 * writes to the audit log.
 *
 * Kept next to the numbers rather than in either caller so the wording is
 * testable: the count of withdrawn codes is the whole answer to "did the kill
 * switch fire?", and someone who cannot reach the database has nothing else to
 * go on.
 */
export function describeWithdrawal(result: InviteWithdrawal): string {
  if (result.matched === 0) {
    return `${result.target}: nothing matched. No codes were changed.`;
  }
  const notes = [
    result.alreadyWithdrawn > 0 ? `${result.alreadyWithdrawn} already withdrawn` : null,
    result.spent > 0 ? `${result.spent} spent and left in circulation` : null,
  ].filter((note): note is string => note !== null);
  const tail = notes.length > 0 ? ` (${notes.join(', ')})` : '';
  return `${result.target}: withdrew ${result.withdrawn} of ${result.matched} codes${tail}.`;
}

export function describeRestoration(result: InviteRestoration): string {
  if (result.matched === 0) {
    return `${result.target}: nothing matched. No codes were changed.`;
  }
  const tail = result.alreadyUsable > 0 ? ` (${result.alreadyUsable} were not withdrawn)` : '';
  return `${result.target}: restored ${result.restored} of ${result.matched} codes${tail}.`;
}

/**
 * Validates the request into a target.
 *
 * A malformed code earns an error rather than `matched: 0`, because "no codes
 * matched" and "that is not the shape of a code" send an operator looking in
 * different places. A *campaign* tag is not validated the same way: an unknown
 * tag is reported as nothing matched, which is the honest answer to a typo the
 * database cannot distinguish from a campaign that was never generated.
 */
function targetOf(request: InviteWithdrawalRequest): Target {
  const code = request.code?.trim() ? normaliseInviteCode(request.code) : null;
  const campaign = request.campaign?.trim() ? request.campaign.trim() : null;
  const unspentOnly = request.unspentOnly === true;

  if (code !== null && campaign !== null) {
    throw new InviteTargetError(ONE_TARGET);
  }
  if (code !== null) {
    if (!looksLikeInviteCode(code)) {
      throw new InviteTargetError(
        `“${request.code}” is not the shape of an invitation code (twelve characters, as in ABCD-EFGH-JKMN).`,
      );
    }
    return { code, unspentOnly };
  }
  if (campaign !== null) {
    return { campaign, unspentOnly };
  }
  throw new InviteTargetError(ONE_TARGET);
}

const ONE_TARGET = 'Name exactly one of a code or a campaign — one leaked invitation, or a whole mailing.';

/** What the operator sees echoed back: the normalised code, or the tag. */
function nameOf(target: Target): string {
  return target.code === undefined ? target.campaign : formatInviteCode(target.code);
}

/**
 * The target as SQL both builder kinds accept.
 *
 * Written with escaped bare column names rather than `invite.code` because an
 * `UpdateQueryBuilder` has no alias to qualify with, and the same string has to
 * serve the census and the `UPDATE` — two spellings of one predicate is how a
 * count stops describing what was changed.
 */
function targetSql(target: Target, quote: (name: string) => string): string {
  return target.code === undefined ? `${quote('campaign')} = :campaign` : `${quote('code')} = :code`;
}

function parametersOf(target: Target): Record<string, string> {
  return target.code === undefined ? { campaign: target.campaign } : { code: target.code };
}

function quoter(manager: EntityManager): (name: string) => string {
  return (name) => manager.connection.driver.escape(name);
}
