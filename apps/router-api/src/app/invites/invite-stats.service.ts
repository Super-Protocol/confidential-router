import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Generation } from '../db/entities/generation.entity.js';
import { InviteCode } from '../db/entities/invite-code.entity.js';
import { InviteRedemption } from '../db/entities/invite-redemption.entity.js';

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
}
