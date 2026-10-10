import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AnalyticsModule } from '../analytics/index.js';
import { User } from '../db/entities/user.entity.js';
import { Workspace } from '../db/entities/workspace.entity.js';
import { WorkspaceMember } from '../db/entities/workspace-member.entity.js';
import { InvitesModule } from '../invites/invites.module.js';
import { MailModule } from '../mail/mail.module.js';
import { AdminGuard } from './admin.guard.js';
import { AuthService } from './auth.service.js';
import { OptionalSessionGuard } from './optional-session.guard.js';
import { SessionGuard } from './session.guard.js';
import { SignInOptionsService } from './sign-in-options.service.js';
import { SignUpGate } from './sign-up-gate.service.js';
import { SignUpProvisioning } from './sign-up-provisioning.service.js';
import { UserProfileService } from './user-profile.service.js';
import { WorkspaceProvisioningService } from './workspace-provisioning.service.js';
import { WorkspaceScopeService } from './workspace-scope.service.js';

@Module({
  // `InvitesModule` for the grant the sign-up hook applies, `AnalyticsModule` for
  // the two events it reports; both dependencies run this way only, and neither
  // invites nor analytics knows about sessions.
  // `MailModule` for the sign-in, reset and welcome mail (SUP-269).
  imports: [TypeOrmModule.forFeature([User, Workspace, WorkspaceMember]), InvitesModule, AnalyticsModule, MailModule],
  providers: [
    AdminGuard,
    AuthService,
    OptionalSessionGuard,
    SessionGuard,
    SignInOptionsService,
    SignUpGate,
    SignUpProvisioning,
    UserProfileService,
    WorkspaceProvisioningService,
    WorkspaceScopeService,
  ],
  exports: [
    AdminGuard,
    AuthService,
    OptionalSessionGuard,
    SessionGuard,
    SignInOptionsService,
    UserProfileService,
    WorkspaceProvisioningService,
    WorkspaceScopeService,
  ],
})
export class AuthModule {}
