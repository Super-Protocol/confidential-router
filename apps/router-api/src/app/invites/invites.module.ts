import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InMemoryTokenBucketRateLimiter, RATE_LIMITER } from '../api/v1/rate-limiter.js';
import { BillingModule } from '../billing/index.js';
import { Generation } from '../db/entities/generation.entity.js';
import { InviteCode } from '../db/entities/invite-code.entity.js';
import { InviteRedemption } from '../db/entities/invite-redemption.entity.js';
import { InviteAttributionService } from './invite-attribution.service.js';
import { InviteStatsService } from './invite-stats.service.js';
import { InviteWithdrawalService } from './invite-withdrawal.service.js';
import { InvitesController } from './invites.controller.js';
import { InvitesService } from './invites.service.js';

/**
 * Invitation codes: the public lookup, the redemption that runs inside sign-up,
 * and the campaign aggregates.
 *
 * `BillingModule` for `LedgerService`, which stays the only writer of the ledger
 * — the grant goes through it like every other entry. The dependency runs one way
 * only: nothing in billing knows invitations exist.
 *
 * `RATE_LIMITER` is bound here to its own bucket instance rather than shared with
 * `V1Module`. Two surfaces, two budgets: a busy tenant's `/v1` traffic must not
 * spend the landing page's lookups, and vice versa.
 */
@Module({
  imports: [TypeOrmModule.forFeature([InviteCode, InviteRedemption, Generation]), BillingModule],
  controllers: [InvitesController],
  providers: [
    { provide: RATE_LIMITER, useClass: InMemoryTokenBucketRateLimiter },
    InvitesService,
    InviteStatsService,
    InviteWithdrawalService,
    InviteAttributionService,
  ],
  // `RATE_LIMITER` is exported so the console's `inviteGrantStatus` query spends
  // the same budget as the public lookup: both answer questions about a code, so
  // a signed-in caller must not get a second allowance for asking.
  exports: [InvitesService, InviteStatsService, InviteWithdrawalService, InviteAttributionService, RATE_LIMITER],
})
export class InvitesModule {}
