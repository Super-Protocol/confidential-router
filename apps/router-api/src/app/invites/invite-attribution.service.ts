import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { InviteRedemption } from '../db/entities/invite-redemption.entity.js';

/** What a campaign-attributed event needs to know about a workspace. */
export interface InviteAttribution {
  /** `InviteCode.campaign`, or undefined when this workspace redeemed nothing. */
  campaign?: string;
  /** Whether this workspace's ledger holds an invitation grant. */
  hadInviteGrant: boolean;
}

export const NO_INVITE_ATTRIBUTION: InviteAttribution = { hadInviteGrant: false };

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
}
