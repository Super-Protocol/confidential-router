import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/index.js';
import { InvitesModule } from '../../invites/invites.module.js';
import { InviteCodesCsvController } from './invite-codes-csv.controller.js';

/**
 * The invitation codes CSV export and import (SUP-272).
 *
 * A module of its own, beside `InvitesModule` rather than inside it: the routes
 * need `AuthModule`'s guards, and `AuthModule` already imports `InvitesModule`
 * for the redemption that runs inside sign-up.
 */
@Module({
  imports: [AuthModule, InvitesModule],
  controllers: [InviteCodesCsvController],
})
export class InviteCodesCsvModule {}
