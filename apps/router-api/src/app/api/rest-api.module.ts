import { Module } from '@nestjs/common';
import { InvitesModule } from '../invites/invites.module.js';
import { HealthModule } from './health/health.module.js';
import { V1Module } from './v1/v1.module.js';

/**
 * REST surface of the service: the health probe, the public invitation lookup and
 * the OpenAI-compatible `/v1`.
 *
 * Import order is load-bearing. `V1Module`'s fallback controller claims every
 * path under `/v1` so that an unknown one answers in the OpenAI error envelope,
 * and Nest registers routes in the order it walks the module graph — so
 * `InvitesModule`, which owns `GET /v1/invites/:code`, has to come first.
 * `invites.e2e.spec.ts` asserts the resulting behaviour rather than this line.
 */
@Module({
  imports: [HealthModule, InvitesModule, V1Module],
})
export class RestApiModule {}
