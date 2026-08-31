import { Module } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { routerConfig } from '../config.js';
import { User } from '../db/entities/user.entity.js';
import { Workspace } from '../db/entities/workspace.entity.js';
import { WorkspaceMember } from '../db/entities/workspace-member.entity.js';
import { AuthService } from './auth.service.js';
import { createMagicLinkMailer, MAGIC_LINK_MAILER } from './magic-link-mailer.js';
import { OptionalSessionGuard } from './optional-session.guard.js';
import { SessionGuard } from './session.guard.js';
import { UserProfileService } from './user-profile.service.js';
import { WorkspaceProvisioningService } from './workspace-provisioning.service.js';
import { WorkspaceScopeService } from './workspace-scope.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([User, Workspace, WorkspaceMember])],
  providers: [
    {
      provide: MAGIC_LINK_MAILER,
      inject: [routerConfig.KEY],
      useFactory: (config: ConfigType<typeof routerConfig>) => createMagicLinkMailer(config.auth),
    },
    AuthService,
    OptionalSessionGuard,
    SessionGuard,
    UserProfileService,
    WorkspaceProvisioningService,
    WorkspaceScopeService,
  ],
  exports: [
    AuthService,
    OptionalSessionGuard,
    SessionGuard,
    UserProfileService,
    WorkspaceProvisioningService,
    WorkspaceScopeService,
  ],
})
export class AuthModule {}
