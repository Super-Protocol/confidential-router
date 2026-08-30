import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApiKeysModule } from '../../api-keys/api-keys.module.js';
import { Generation } from '../../db/entities/generation.entity.js';
import { MeteringModule } from '../../metering/metering.module.js';
import { ApiKeyGuard } from './api-key.guard.js';
import { GatewayController } from './gateway.controller.js';
import { GatewayService } from './gateway.service.js';
import { GatewayPolicyService } from './gateway-policy.service.js';
import { GenerationRecorder } from './generation-recorder.service.js';
import { GenerationsController } from './generations.controller.js';
import { LiteLlmClient } from './litellm.client.js';
import { ModelsController } from './models.controller.js';
import { RateLimitService } from './rate-limit.service.js';
import { InMemoryTokenBucketRateLimiter, RATE_LIMITER } from './rate-limiter.js';
import { V1FallbackController } from './v1-fallback.controller.js';

/**
 * The OpenAI-compatible gateway.
 *
 * Controller order is load-bearing: `V1FallbackController` claims everything
 * under `/v1`, so it has to be registered after the routes that matter.
 *
 * `RATE_LIMITER` is bound here to the in-process token bucket. A multi-replica
 * deployment swaps in a Redis adapter by changing this one provider — nothing
 * else in the module knows which implementation it got.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Generation]), ApiKeysModule, MeteringModule],
  controllers: [GatewayController, ModelsController, GenerationsController, V1FallbackController],
  providers: [
    { provide: RATE_LIMITER, useClass: InMemoryTokenBucketRateLimiter },
    ApiKeyGuard,
    GatewayPolicyService,
    GatewayService,
    GenerationRecorder,
    LiteLlmClient,
    RateLimitService,
  ],
})
export class V1Module {}
