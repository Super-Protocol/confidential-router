import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { InviteRedemption } from '../db/entities/invite-redemption.entity.js';

/** What a campaign-attributed event needs to know about a workspace. */
export interface InviteAttribution {
  /** `InviteCode.campaign`, or undefined when this workspace redeemed nothing. */
  campaign?: string;
  /** Whether this workspace's ledger holds an invitation grant. */
  hadInviteGrant: boolean;
}

export const NO_INVITE_ATTRIBUTION: InviteAttribution = { hadInviteGrant: false };

/** Which code an account was created with — the admin console's "came from" column. */
export interface UserInviteAttribution {
  userId: string;
  inviteCodeId: string;
  /** Normalised code. The console masks it until an operator asks to see it. */
  code: string;
  campaign: string;
  redeemedAt: Date;
}

/** Ids per `IN`, under SQLite's 999 bound-parameter ceiling. */
const USER_CHUNK = 500;

/**
 * Which campaign a workspace arrived with.
 *
 * `campaign` is the taxonomy's join key — it appears on the landing page's
 * events, on the console's, and on the redemption row — so almost every
 * server-side event has to be able to answer it from a workspace id alone
 * (`docs/contracts/analytics-events.md`, shared properties).
 *
 * It lives in `InvitesModule` because the two tables are invitations' own, and
 * it is separate from `InvitesService` because its callers are not redeeming
 * anything: `api_key_created` and `first_request_sent` are emitted from the key
 * resolver and the meter, and neither should be reaching for a service whose
 * other method spends a code.
 *
 * One row, on a unique index, once per event. Not cached: a workspace's
 * redemption is written once and never changes, but a cache keyed by workspace
 * would grow with the tenant count for a query that costs an index hit.
 */
@Injectable()
export class InviteAttributionService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async forWorkspace(workspaceId: string): Promise<InviteAttribution> {
    const redemption = await this.dataSource.getRepository(InviteRedemption).findOne({
      where: { workspaceId },
      relations: { inviteCode: true },
    });

    return redemption ? { campaign: redemption.inviteCode?.campaign, hadInviteGrant: true } : NO_INVITE_ATTRIBUTION;
  }

  /**
   * The code each of these accounts redeemed, keyed by user id. An account that
   * redeemed nothing is absent from the map rather than present as null.
   *
   * Keyed by user rather than workspace because the admin console lists people:
   * one redemption per account is the policy the unique index on
   * `invite_redemptions.userId` enforces, so the key is exact.
   */
  async forUsers(userIds: readonly string[]): Promise<Map<string, UserInviteAttribution>> {
    const attributions = new Map<string, UserInviteAttribution>();
    for (let at = 0; at < userIds.length; at += USER_CHUNK) {
      const redemptions = await this.dataSource.getRepository(InviteRedemption).find({
        where: { userId: In(userIds.slice(at, at + USER_CHUNK)) },
        relations: { inviteCode: true },
      });
      for (const redemption of redemptions) {
        if (!redemption.inviteCode) {
          continue;
        }
        attributions.set(redemption.userId, {
          userId: redemption.userId,
          inviteCodeId: redemption.inviteCodeId,
          code: redemption.inviteCode.code,
          campaign: redemption.inviteCode.campaign,
          redeemedAt: redemption.redeemedAt,
        });
      }
    }
    return attributions;
  }
}
