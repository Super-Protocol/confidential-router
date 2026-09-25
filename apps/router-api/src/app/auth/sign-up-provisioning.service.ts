import { Injectable, Logger } from '@nestjs/common';
import { AnalyticsService, eventUuid } from '../analytics/index.js';
import type { InviteRedemptionOutcome } from '../invites/invites.service.js';
import { InvitesService } from '../invites/invites.service.js';
import type { SignUpInvite } from '../invites/sign-up-invite.js';
import type { SignUpMethod } from './sign-up-method.js';
import { WorkspaceProvisioningService } from './workspace-provisioning.service.js';

/** Everything the two sign-up events are derived from, once the grant has resolved. */
interface SignUpReport {
  user: CreatedUser;
  invite: SignUpInvite;
  method: SignUpMethod;
  outcome: InviteRedemptionOutcome;
}

/** The user Better Auth has just inserted. */
export interface CreatedUser {
  id: string;
  email: string;
  name?: string | null;
}

/**
 * Everything that has to happen the moment an account comes into existence, in
 * order: the personal workspace, then the invitation grant into it, then the two
 * analytics events that report what happened.
 *
 * It exists so `AuthService` stays the narrow boundary ADR-004 §3 asks for — one
 * callback into the application, not a growing list of things to remember on
 * sign-up — and so the ordering is written down in one place: the grant is a
 * ledger entry against a workspace, so the workspace has to be there first, and
 * the events report a redemption, so they come last.
 *
 * No step may fail the registration. Better Auth awaits this hook, so a throw
 * here would answer the sign-up with an error after the row had already been
 * inserted, leaving an account nobody can sign in to explain. Provisioning is
 * idempotent and retried on the next sign-in; the grant reports its own failure
 * and is not retried, because a mailing-list mistake must not cost the visitor
 * their account (SUP-142); `AnalyticsService.capture` never rejects at all.
 */
@Injectable()
export class SignUpProvisioning {
  private readonly logger = new Logger(SignUpProvisioning.name);

  constructor(
    private readonly workspaces: WorkspaceProvisioningService,
    private readonly invites: InvitesService,
    private readonly analytics: AnalyticsService,
  ) {}

  async onUserCreated(user: CreatedUser, invite: SignUpInvite, method: SignUpMethod): Promise<void> {
    const workspace = await this.workspaces.ensurePersonalWorkspace(user);

    const outcome = await this.invites.redeemOnSignUp({
      userId: user.id,
      workspaceId: workspace.id,
      invite,
    });
    if (outcome.status === 'refused') {
      // Worth a line: it is the difference between a campaign that converted and
      // one whose codes were all spent before the mail went out.
      this.logger.warn(`Invitation code presented at sign-up was not redeemed (${outcome.reason}).`);
    }

    await this.report({ user, invite, method, outcome });
  }

  /**
   * `signup_completed`, and `invite_redeemed` when a code was presented.
   *
   * Both are captured here rather than from a controller because this is the
   * commit boundary the taxonomy names: the account exists, so the event exists.
   * `campaign` is taken from the outcome rather than looked up — a granted
   * redemption already knows it, and a refused one has no campaign to report
   * because the code it carried was not a code we issued.
   *
   * The first identified event of an account's life, so it is also where the two
   * allowed person properties are set.
   */
  private async report({ user, invite, method, outcome }: SignUpReport): Promise<void> {
    const campaign = outcome.status === 'granted' ? outcome.campaign : undefined;

    await this.analytics.capture({
      event: 'signup_completed',
      distinctId: user.id,
      uuid: eventUuid('signup_completed', user.id),
      properties: { has_invite: invite.code !== null, campaign, method },
      person: { campaign, signup_method: method },
    });

    if (outcome.status === 'none') {
      // "A sign-up with no code sends nothing" — the overwhelmingly common case
      // once the campaign is over, and a `refused` row for it would make every
      // organic sign-up look like a failed redemption.
      return;
    }

    await this.analytics.capture({
      event: 'invite_redeemed',
      distinctId: user.id,
      // A granted redemption has a row; a refusal has none, so the id is derived
      // from the account it was refused for — one refusal per account, which is
      // exactly what a retried hook should produce.
      uuid:
        outcome.status === 'granted'
          ? eventUuid('invite_redeemed', outcome.redemptionId)
          : eventUuid('invite_redeemed', 'refused', user.id),
      properties:
        outcome.status === 'granted'
          ? { outcome: 'granted', campaign: outcome.campaign, grant_micros: outcome.grantMicros }
          : { outcome: 'refused', reason: outcome.reason },
    });
  }
}
