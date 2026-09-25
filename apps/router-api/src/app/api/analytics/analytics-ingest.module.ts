import { Module } from '@nestjs/common';
import { AnalyticsModule } from '../../analytics/index.js';
import { AuthModule } from '../../auth/index.js';
import { InMemoryTokenBucketRateLimiter, RATE_LIMITER } from '../v1/rate-limiter.js';
import { AnalyticsIngestController } from './analytics-ingest.controller.js';

/**
 * The console's analytics ingest, as a delivery-layer module of its own.
 *
 * Separate from `AnalyticsModule` because of the direction of the two
 * dependencies. `AuthModule` needs analytics — `signup_completed` and
 * `invite_redeemed` are emitted from the sign-up hook — and this controller needs
 * `OptionalSessionGuard`, which is `AuthModule`'s. Folding the controller into
 * `AnalyticsModule` would make the pair circular; keeping the transport free of
 * every domain dependency and putting the surface under `api/` next to the other
 * two surfaces makes it a straight line.
 *
 * `RATE_LIMITER` is bound here to its own bucket instance, not shared with
 * `V1Module` or `InvitesModule`: three surfaces, three budgets.
 */
@Module({
  imports: [AnalyticsModule, AuthModule],
  controllers: [AnalyticsIngestController],
  providers: [{ provide: RATE_LIMITER, useClass: InMemoryTokenBucketRateLimiter }],
})
export class AnalyticsIngestModule {}
