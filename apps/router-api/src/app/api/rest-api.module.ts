import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module.js';
import { V1Module } from './v1/v1.module.js';

/** REST surface of the service: the health probe and the OpenAI-compatible `/v1`. */
@Module({
  imports: [HealthModule, V1Module],
})
export class RestApiModule {}
