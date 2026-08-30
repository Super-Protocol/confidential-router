import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module.js';

/** REST surface of the service. `/v1/*` (OpenAI-compatible) lands here in SUP-73. */
@Module({
  imports: [HealthModule],
})
export class RestApiModule {}
