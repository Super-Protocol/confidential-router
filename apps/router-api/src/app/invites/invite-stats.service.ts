import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, IsNull, Not } from 'typeorm';
import { Generation } from '../db/entities/generation.entity.js';
import { InviteCode } from '../db/entities/invite-code.entity.js';
import { InviteRedemption } from '../db/entities/invite-redemption.entity.js';
import { User } from '../db/entities/user.entity.js';

export interface InviteCampaignStats {
  campaign: string;
  /** Codes generated for the campaign. */
  issued: number;
  /** Accounts that redeemed one. */
  redeemed: number;
  /** `redeemed / issued`, 0 when nothing was issued. */
  redemptionRate: number;
  /**
   * Redeeming accounts whose workspace went on to send at least one request.
   *
   * The number a campaign is actually judged on: a redemption is a sign-up, and
   * a sign-up that never sends a token bought nothing.
   */
  activated: number;
  /** Micro-USD handed out so far. */
  grantedMicros: number;
}

/** Deployment-wide invitation numbers — the summary row of the admin console. */
export interface InviteTotals {
  /** Codes ever generated. */
  issued: number;
  /** Redemptions ever made — one per invited account. */
  redeemed: number;
  /** Codes an operator withdrew. */
  withdrawn: number;
  /** `redeemed / issued`, 0 when nothing was issued. Same definition as a campaign's. */
  redemptionRate: number;
  /** Micro-USD handed out through invitations. */
  grantedMicros: number;
  /** Accounts on the deployment, however they arrived. */
  signUps: number;
}

/** One UTC day of the admin console's charts. */
export interface InviteDay {
  /** `YYYY-MM-DD`, UTC. */
  date: string;
  codesIssued: number;
  codesRedeemed: number;
  signUpsInvited: number;
  signUpsBootstrap: number;
  signUpsOpen: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How a campaign did.
 *
 * Four aggregates over three tables, computed on demand rather than kept in a
 * rollup: a campaign is read by an operator a handful of times a day, and a
 * cached counter would be a second source of truth to keep correct — the same
 * reasoning that left `activity_rollups` unwritten (`data-model.md`).
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

    const workspaceIds = redemptions.map((row) => row.workspaceId);
    return {
      campaign,
      issued,
      redeemed: redemptions.length,
      redemptionRate: issued === 0 ? 0 : redemptions.length / issued,
      activated: await this.countActivated(workspaceIds),
      grantedMicros: await this.sumGranted(campaign),
    };
  }

  /**
   * How many of those workspaces have a generation.
   *
   * Chunked because the id list comes from the redemptions and a launch campaign
   * can have thousands: SQLite refuses a statement with more than 999 bound
   * parameters, and a single `IN` over every redeemer would hit it.
   */
  private async countActivated(workspaceIds: string[]): Promise<number> {
    const CHUNK = 500;
    let activated = 0;
    for (let at = 0; at < workspaceIds.length; at += CHUNK) {
      const chunk = workspaceIds.slice(at, at + CHUNK);
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
    const redeemed = await this.dataSource.getRepository(InviteRedemption).count();
    const granted = await this.dataSource
      .getRepository(InviteRedemption)
      .createQueryBuilder('redemption')
      .innerJoin('redemption.inviteCode', 'code')
      .select('SUM(code.grantMicros)', 'total')
      .getRawOne<{ total: string | number | null }>();
    return {
      issued,
      redeemed,
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
   * (`ForeignDateTransformer`). The window is bounded, so the rows are too —
   * except for the account list, which is read whole because its timestamp
   * cannot be compared in SQL portably. That is one id and one timestamp per
   * account, on a deployment whose accounts are, by construction, invited.
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
