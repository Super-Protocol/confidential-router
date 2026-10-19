import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, IsNull, Not } from 'typeorm';
import { Generation } from '../db/entities/generation.entity.js';
import { InviteCarriedRedemption } from '../db/entities/invite-carried-redemption.entity.js';
import { InviteCode } from '../db/entities/invite-code.entity.js';
import { InviteRedemption } from '../db/entities/invite-redemption.entity.js';
import { User } from '../db/entities/user.entity.js';
import { WorkspaceMember } from '../db/entities/workspace-member.entity.js';

export interface InviteCampaignStats {
  campaign: string;
  /** Codes generated for the campaign. */
  issued: number;
  /**
   * People who used one, whichever deployment they used it on.
   *
   * Carried redemptions count here (SUP-396). The question this answers is "did
   * anyone use this code", and a redemption a CSV import brought over is a person
   * who did — on prod every code but the QA ones arrived that way, so counting
   * only live rows reported a redeemed launch campaign as `Redeemed 0`.
   */
  redeemed: number;
  /** How many of `redeemed` a CSV import carried over, rather than happening here. */
  carried: number;
  /** `redeemed / issued`, 0 when nothing was issued. */
  redemptionRate: number;
  /**
   * Redeeming accounts whose workspace went on to send at least one request.
   *
   * The number a campaign is actually judged on: a redemption is a sign-up, and
   * a sign-up that never sends a token bought nothing. A carried redeemer counts
   * once the address matches an account here — the same read-time match the Codes
   * tab shows — and cannot before, since there is no workspace to have sent
   * anything.
   */
  activated: number;
  /**
   * Micro-USD handed out so far.
   *
   * Live redemptions only, and deliberately: a carried redemption was paid by
   * another deployment's ledger, so counting it here would report credit this
   * one never wrote ({@link InviteCarriedRedemption}).
   */
  grantedMicros: number;
}

/** Deployment-wide invitation numbers — the summary row of the admin console. */
export interface InviteTotals {
  /** Codes ever generated. */
  issued: number;
  /** Redemptions ever made — one per invited account, carried ones included. */
  redeemed: number;
  /** How many of `redeemed` a CSV import carried over. */
  carried: number;
  /** Codes an operator withdrew. */
  withdrawn: number;
  /** `redeemed / issued`, 0 when nothing was issued. Same definition as a campaign's. */
  redemptionRate: number;
  /** Micro-USD handed out through invitations. Live redemptions only, as a campaign's is. */
  grantedMicros: number;
  /** Accounts on the deployment, however they arrived. */
  signUps: number;
}

/** One UTC day of the admin console's charts. */
export interface InviteDay {
  /** `YYYY-MM-DD`, UTC. */
  date: string;
  codesIssued: number;
  /** Redemptions stamped this day, carried ones under the date they happened on. */
  codesRedeemed: number;
  signUpsInvited: number;
  signUpsBootstrap: number;
  signUpsOpen: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Ids or addresses per `IN`, under SQLite's 999 bound-parameter ceiling. */
const CHUNK = 500;

/**
 * How a campaign did.
 *
 * A handful of aggregates over a handful of tables, computed on demand rather
 * than kept in a rollup: a campaign is read by an operator a handful of times a
 * day, and a cached counter would be a second source of truth to keep correct —
 * the same reasoning that left `activity_rollups` unwritten (`data-model.md`).
 *
 * "Redeemed" spans two tables, not one: `invite_redemptions` for a redemption
 * that happened here and `invite_carried_redemptions` for one a CSV import
 * brought over (SUP-272). Both are a person who used a code, so both are counted
 * — see {@link InviteCampaignStats.redeemed}. Only the money stays live-only.
 */
@Injectable()
export class InviteStatsService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** Every campaign that has codes, newest first; or just the one named. */
  async campaigns(campaign?: string | null): Promise<InviteCampaignStats[]> {
    const names = campaign ? [campaign] : await this.campaignNames();
    return Promise.all(names.map((name) => this.statsOf(name)));
  }

  /**
   * Campaign tags, most recently generated first.
   *
   * The name breaks the tie on the timestamp rather than leaving it to the
   * database: `createdAt` is a millisecond, and two campaigns generated in the
   * same one would otherwise come back in whatever order the plan happened to
   * produce — which makes an operator's list, and any test of it, unstable.
   */
  private async campaignNames(): Promise<string[]> {
    const rows = await this.dataSource
      .getRepository(InviteCode)
      .createQueryBuilder('code')
      .select('code.campaign', 'campaign')
      .addSelect('MAX(code.createdAt)', 'latest')
      .groupBy('code.campaign')
      .orderBy('latest', 'DESC')
      .addOrderBy('campaign', 'ASC')
      .getRawMany<{ campaign: string }>();
    return rows.map((row) => row.campaign);
  }

  private async statsOf(campaign: string): Promise<InviteCampaignStats> {
    const issued = await this.dataSource.getRepository(InviteCode).count({ where: { campaign } });
    const redemptions = await this.dataSource
      .getRepository(InviteRedemption)
      .createQueryBuilder('redemption')
      .innerJoin('redemption.inviteCode', 'code')
      .where('code.campaign = :campaign', { campaign })
      .select('redemption.workspaceId', 'workspaceId')
      .getRawMany<{ workspaceId: string }>();
    const carried = await this.carriedOf(campaign);

    const redeemed = redemptions.length + carried.length;
    const workspaceIds = [
      ...redemptions.map((row) => row.workspaceId),
      ...(await this.workspacesOfAddresses(carried.flatMap((row) => (row.email ? [row.email] : [])))),
    ];
    return {
      campaign,
      issued,
      redeemed,
      carried: carried.length,
      redemptionRate: issued === 0 ? 0 : redeemed / issued,
      activated: await this.countActivated(workspaceIds),
      grantedMicros: await this.sumGranted(campaign),
    };
  }

  /** The import-carried redemptions of this campaign's codes. */
  private async carriedOf(campaign: string): Promise<{ email: string | null }[]> {
    return this.dataSource
      .getRepository(InviteCarriedRedemption)
      .createQueryBuilder('carried')
      .innerJoin('carried.inviteCode', 'code')
      .where('code.campaign = :campaign', { campaign })
      .select('carried.email', 'email')
      .getRawMany<{ email: string | null }>();
  }

  /**
   * The workspaces of the accounts behind these addresses — how a carried
   * redemption reaches `activated` at all, since the row names an address and not
   * a workspace.
   *
   * Matched on every read rather than stored, exactly as the Codes tab matches
   * them (`InviteAdminService.accountsOf`): someone who signs up here after
   * the import starts counting the moment they do, without anything being
   * rewritten. An address with no account yields nothing, which is right — there
   * is no workspace that could have sent a request.
   */
  private async workspacesOfAddresses(addresses: readonly string[]): Promise<string[]> {
    const unique = [...new Set(addresses)];
    const workspaceIds: string[] = [];
    for (let at = 0; at < unique.length; at += CHUNK) {
      const rows = await this.dataSource
        .getRepository(WorkspaceMember)
        .createQueryBuilder('member')
        .innerJoin(User, 'account', 'account.id = member.userId')
        .where('account.email IN (:...addresses)', { addresses: unique.slice(at, at + CHUNK) })
        .select('member.workspaceId', 'workspaceId')
        .getRawMany<{ workspaceId: string }>();
      workspaceIds.push(...rows.map((row) => row.workspaceId));
    }
    return workspaceIds;
  }

  /**
   * How many of those workspaces have a generation.
   *
   * Deduplicated first: the list is two lists concatenated, and an account that
   * redeemed here *and* matches a carried address would otherwise be activated
   * twice. Chunked because a launch campaign can have thousands of redeemers:
   * SQLite refuses a statement with more than 999 bound parameters, and a single
   * `IN` over every one of them would hit it.
   */
  private async countActivated(workspaceIds: readonly string[]): Promise<number> {
    const unique = [...new Set(workspaceIds)];
    let activated = 0;
    for (let at = 0; at < unique.length; at += CHUNK) {
      const chunk = unique.slice(at, at + CHUNK);
      const rows = await this.dataSource
        .getRepository(Generation)
        .createQueryBuilder('generation')
        .select('generation.workspaceId', 'workspaceId')
        .where('generation.workspaceId IN (:...workspaceIds)', { workspaceIds: chunk })
        .groupBy('generation.workspaceId')
        .getRawMany<{ workspaceId: string }>();
      activated += rows.length;
    }
    return activated;
  }

  private async sumGranted(campaign: string): Promise<number> {
    const row = await this.dataSource
      .getRepository(InviteRedemption)
      .createQueryBuilder('redemption')
      .innerJoin('redemption.inviteCode', 'code')
      .where('code.campaign = :campaign', { campaign })
      .select('SUM(code.grantMicros)', 'total')
      .getRawOne<{ total: string | number | null }>();
    return Number(row?.total ?? 0);
  }

  /** The deployment-wide summary. */
  async totals(): Promise<InviteTotals> {
    const codes = this.dataSource.getRepository(InviteCode);
    const issued = await codes.count();
    const withdrawn = await codes.count({ where: { disabledAt: Not(IsNull()) } });
    const live = await this.dataSource.getRepository(InviteRedemption).count();
    const carried = await this.dataSource.getRepository(InviteCarriedRedemption).count();
    const redeemed = live + carried;
    const granted = await this.dataSource
      .getRepository(InviteRedemption)
      .createQueryBuilder('redemption')
      .innerJoin('redemption.inviteCode', 'code')
      .select('SUM(code.grantMicros)', 'total')
      .getRawOne<{ total: string | number | null }>();
    return {
      issued,
      redeemed,
      carried,
      withdrawn,
      redemptionRate: issued === 0 ? 0 : redeemed / issued,
      grantedMicros: Number(granted?.total ?? 0),
      signUps: await this.dataSource.getRepository(User).count(),
    };
  }

  /**
   * The last `days` UTC days, oldest first, with every day present — a day with
   * nothing in it is a zero, not a gap, so a chart's columns are evenly spaced.
   *
   * Bucketed here rather than with a `GROUP BY` on a date expression: the date
   * functions differ between PostgreSQL and SQLite, and `user.createdAt` is a
   * column Better Auth gave a different physical type on each
   * (`ForeignDateTransformer`). Only the issued codes are narrowed in SQL; the
   * accounts, the redemptions and the carried redemptions are read whole and
   * bucketed here — the first because its timestamp cannot be compared in SQL
   * portably, the other two because every row of them is needed anyway (the
   * `invited` set, and `codesRedeemed` over a window the import may predate).
   * That is one id and one timestamp per row, on a deployment whose accounts are,
   * by construction, invited.
   *
   * `bootstrapId` is the account `/auth/bootstrap` created, if any
   * (`InviteAdminService.bootstrapAccountId`).
   */
  async daily(days: number, bootstrapId: string | null, now: Date = new Date()): Promise<InviteDay[]> {
    const firstDay = Math.floor(now.getTime() / DAY_MS) - (days - 1);
    const since = new Date(firstDay * DAY_MS);
    const series = Array.from({ length: days }, (_, index) => ({
      date: new Date((firstDay + index) * DAY_MS).toISOString().slice(0, 10),
      codesIssued: 0,
      codesRedeemed: 0,
      signUpsInvited: 0,
      signUpsBootstrap: 0,
      signUpsOpen: 0,
    }));
    const dayOf = (at: Date): InviteDay | undefined => series[Math.floor(at.getTime() / DAY_MS) - firstDay];

    // Epoch milliseconds, as `TimestampTransformer` stores them.
    const issued = await this.dataSource
      .getRepository(InviteCode)
      .createQueryBuilder('code')
      .select(['code.id', 'code.createdAt'])
      .where('code.createdAt >= :since', { since: since.getTime() })
      .getMany();
    for (const code of issued) {
      const day = dayOf(code.createdAt);
      if (day) day.codesIssued += 1;
    }

    const redemptions = await this.dataSource.getRepository(InviteRedemption).find({
      select: { id: true, userId: true, redeemedAt: true },
    });
    const invited = new Set<string>();
    for (const redemption of redemptions) {
      invited.add(redemption.userId);
      const day = redemption.redeemedAt.getTime() >= since.getTime() ? dayOf(redemption.redeemedAt) : undefined;
      if (day) day.codesRedeemed += 1;
    }

    // Carried redemptions are dated when they happened on the deployment the file
    // came from, not when the import ran — so a rebuilt deployment draws the curve
    // its codes were actually redeemed on rather than one bar on import day.
    const imported = await this.dataSource
      .getRepository(InviteCarriedRedemption)
      .find({ select: { id: true, redeemedAt: true } });
    for (const redemption of imported) {
      const day = redemption.redeemedAt.getTime() >= since.getTime() ? dayOf(redemption.redeemedAt) : undefined;
      if (day) day.codesRedeemed += 1;
    }

    const accounts = await this.dataSource.getRepository(User).find({ select: { id: true, createdAt: true } });
    for (const account of accounts) {
      const day = account.createdAt.getTime() >= since.getTime() ? dayOf(account.createdAt) : undefined;
      if (!day) continue;
      if (invited.has(account.id)) day.signUpsInvited += 1;
      else if (account.id === bootstrapId) day.signUpsBootstrap += 1;
      else day.signUpsOpen += 1;
    }
    return series;
  }
}
