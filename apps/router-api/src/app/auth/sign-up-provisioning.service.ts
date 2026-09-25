import { Injectable, Logger } from '@nestjs/common';
import { InvitesService } from '../invites/invites.service.js';
import type { SignUpInvite } from '../invites/sign-up-invite.js';
import { WorkspaceProvisioningService } from './workspace-provisioning.service.js';

/** The user Better Auth has just inserted. */
export interface CreatedUser {
  id: string;
  email: string;
  name?: string | null;
}

/**
 * Everything that has to happen the moment an account comes into existence, in
 * order: the personal workspace, then the invitation grant into it.
 *
 * It exists so `AuthService` stays the narrow boundary ADR-004 §3 asks for — one
 * callback into the application, not a growing list of things to remember on
 * sign-up — and so the ordering is written down in one place: the grant is a
 * ledger entry against a workspace, so the workspace has to be there first.
 *
 * Neither step may fail the registration. Better Auth awaits this hook, so a
 * throw here would answer the sign-up with an error after the row had already
 * been inserted, leaving an account nobody can sign in to explain. Provisioning
 * is idempotent and retried on the next sign-in; the grant reports its own
 * failure and is not retried, because a mailing-list mistake must not cost the
 * visitor their account (SUP-142).
 */
@Injectable()
export class SignUpProvisioning {
  private readonly logger = new Logger(SignUpProvisioning.name);

  constructor(
    private readonly workspaces: WorkspaceProvisioningService,
    private readonly invites: InvitesService,
  ) {}

  async onUserCreated(user: CreatedUser, invite: SignUpInvite): Promise<void> {
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
  }
}
