import { Controller, Headers, HttpCode, Inject, NotFoundException, Post, Req, Res } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { RATE_LIMITER, type RateLimiter } from '../api/v1/rate-limiter.js';
import { routerConfig } from '../config.js';
import { FeedbackWebhookDto } from './feedback.dto.js';
import { FeedbackRateLimitedError } from './feedback.errors.js';
import { FeedbackService } from './feedback.service.js';
import { TYPEFORM_SIGNATURE_HEADER } from './typeform.js';

/** Where the form provider posts. `bootstrap.ts` keeps the raw body for it. */
export const TYPEFORM_WEBHOOK_PATH = '/v1/webhooks/typeform';

/**
 * The form provider's callback, and the only way the second grant is ever
 * applied.
 *
 * Authenticated by two independent signatures and by nothing else — no session,
 * no API key: the provider's HMAC over the raw bytes says the delivery is real,
 * and our own short-lived token inside it says which account asked for the form.
 * Either one missing and the request grants nothing.
 *
 * Like `GET /v1/invites/:code` it lives under `/v1` without being
 * OpenAI-compatible or key-authenticated, so it is registered before
 * `V1FallbackController`, which claims everything else under that prefix.
 */
@ApiTags('feedback')
@Controller('v1/webhooks')
export class FeedbackController {
  constructor(
    private readonly feedback: FeedbackService,
    @Inject(routerConfig.KEY) private readonly config: ConfigType<typeof routerConfig>,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
  ) {}

  @Post('typeform')
  // Always 200 once the delivery is authenticated, whatever it decided: a
  // provider that does not read a 2xx redelivers for days.
  @HttpCode(200)
  @ApiOperation({ summary: 'Feedback form submissions. Applies the second grant, once per account.' })
  async typeform(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Headers(TYPEFORM_SIGNATURE_HEADER) signature?: string,
  ): Promise<FeedbackWebhookDto> {
    // A hard 404 where no form is configured, the same way the bootstrap
    // endpoint disappears once it is no longer meant to exist: an endpoint that
    // answered would be telling a prober that this deployment has a grant to
    // give away.
    if (!this.feedback.configured) {
      throw new NotFoundException();
    }
    await this.admit(response);

    const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.from(JSON.stringify(request.body ?? {}), 'utf8');
    const outcome = await this.feedback.handleDelivery(raw, signature);
    return outcome.status === 'refused' ? { outcome: 'refused', reason: outcome.reason } : { outcome: outcome.status };
  }

  /**
   * Charges one delivery against the caller's minute budget.
   *
   * The signature is the authority, not this. The budget exists so that an
   * unsigned flood cannot spend the service's time verifying HMACs, and it is
   * generous enough that a real provider's retries never hit it.
   */
  private async admit(response: Response): Promise<void> {
    const ip = response.req.ip ?? 'unknown';
    const decision = await this.limiter.consume(`feedback:ip:${ip}`, {
      cost: 1,
      limitPerMinute: this.config.feedback.webhooksPerMinute,
    });
    if (!decision.allowed) {
      response.setHeader('Retry-After', String(decision.retryAfterSeconds));
      throw new FeedbackRateLimitedError();
    }
  }
}
