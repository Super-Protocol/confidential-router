import { Module } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { routerConfig } from '../config.js';
import { User } from '../db/entities/user.entity.js';
import { Workspace } from '../db/entities/workspace.entity.js';
import { WorkspaceMember } from '../db/entities/workspace-member.entity.js';
import { InvitesModule } from '../invites/invites.module.js';
import { AdminGuard } from './admin.guard.js';
import { AuthService } from './auth.service.js';
import { createMagicLinkMailer, MAGIC_LINK_MAILER } from './magic-link-mailer.js';
import { OptionalSessionGuard } from './optional-session.guard.js';
import { SessionGuard } from './session.guard.js';
import { SignInOptionsService } from './sign-in-options.service.js';
import { SignUpProvisioning } from './sign-up-provisioning.service.js';
import { UserProfileService } from './user-profile.service.js';
import { WorkspaceProvisioningService } from './workspace-provisioning.service.js';
import { WorkspaceScopeService } from './workspace-scope.service.js';

@Module({
  // `InvitesModule` for the grant the sign-up hook applies; the dependency runs
  // this way only, and nothing in invites knows about sessions.
  imports: [TypeOrmModule.forFeature([User, Workspace, WorkspaceMember]), InvitesModule],
  providers: [
    {
      provide: MAGIC_LINK_MAILER,
      inject: [routerConfig.KEY],
      useFactory: (config: ConfigType<typeof routerConfig>) => createMagicLinkMailer(config.auth),
    },
    AdminGuard,
    AuthService,
    OptionalSessionGuard,
    SessionGuard,
    SignInOptionsService,
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
