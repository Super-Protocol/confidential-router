import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AnalyticsModule } from '../analytics/index.js';
import { InMemoryTokenBucketRateLimiter, RATE_LIMITER } from '../api/v1/rate-limiter.js';
import { BillingModule } from '../billing/index.js';
import { FeedbackSubmission } from '../db/entities/feedback-submission.entity.js';
import { Generation } from '../db/entities/generation.entity.js';
import { InviteRedemption } from '../db/entities/invite-redemption.entity.js';
import { Workspace } from '../db/entities/workspace.entity.js';
import { FeedbackController } from './feedback.controller.js';
import { FeedbackService } from './feedback.service.js';
import { CapturingFeedbackAnalytics, FEEDBACK_ANALYTICS } from './feedback-analytics.js';
import { FeedbackEligibilityService } from './feedback-eligibility.service.js';
import { FeedbackGrantRecorder } from './feedback-grant.recorder.js';

/**
 * The second grant: eligibility, the signed form link, and the webhook that
 * credits it.
 *
 * `BillingModule` for `LedgerService`, which stays the only writer of the
 * ledger — a feedback grant is an ordinary `grant` entry, written through the
 * same path an invitation grant takes. The dependency runs one way: nothing in
 * billing knows this feature exists.
 *
 * `RATE_LIMITER` is bound to its own bucket instance, as in `InvitesModule`:
 * three surfaces, three budgets, so a busy tenant's `/v1` traffic cannot spend
 * the webhook's allowance or the landing page's.
 *
 * `FEEDBACK_ANALYTICS` is bound to `CapturingFeedbackAnalytics`, which forwards
 * `feedback_grant_applied` to `AnalyticsService` — hence `AnalyticsModule` in
 * the imports. The port stays because the emission is this feature's and the
 * transport is ADR-006 §3's; what the port no longer has is a no-op default
 * (SUP-465).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([FeedbackSubmission, InviteRedemption, Generation, Workspace]),
    BillingModule,
    AnalyticsModule,
  ],
  controllers: [FeedbackController],
  providers: [
    { provide: RATE_LIMITER, useClass: InMemoryTokenBucketRateLimiter },
    { provide: FEEDBACK_ANALYTICS, useClass: CapturingFeedbackAnalytics },
    FeedbackEligibilityService,
    FeedbackGrantRecorder,
    FeedbackService,
  ],
  exports: [FeedbackService, FeedbackEligibilityService],
})
export class FeedbackModule {}
