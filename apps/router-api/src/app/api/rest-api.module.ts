import { Module } from '@nestjs/common';
import { FeedbackModule } from '../feedback/feedback.module.js';
import { InvitesModule } from '../invites/invites.module.js';
import { HealthModule } from './health/health.module.js';
import { V1Module } from './v1/v1.module.js';

/**
 * REST surface of the service: the health probe, the public invitation lookup,
 * the feedback form's webhook and the OpenAI-compatible `/v1`.
 *
 * Import order is load-bearing. `V1Module`'s fallback controller claims every
 * path under `/v1` so that an unknown one answers in the OpenAI error envelope,
 * and Nest registers routes in the order it walks the module graph — so
 * `InvitesModule` (`GET /v1/invites/:code`) and `FeedbackModule`
 * (`POST /v1/webhooks/typeform`) both have to come first. `invites.e2e.spec.ts`
 * and `feedback.e2e.spec.ts` assert the resulting behaviour rather than these
 * lines.
 */
@Module({
  imports: [HealthModule, InvitesModule, FeedbackModule, V1Module],
})
export class RestApiModule {}
