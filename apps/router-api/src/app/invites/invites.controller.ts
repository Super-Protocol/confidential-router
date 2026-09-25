import { Controller, Get, Header, Inject, Param, Res } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { RATE_LIMITER, type RateLimiter } from '../api/v1/rate-limiter.js';
import { routerConfig } from '../config.js';
import { InviteLookupDto } from './invites.dto.js';
import { InviteRateLimitedError } from './invites.errors.js';
import { InvitesService } from './invites.service.js';

/**
 * The one public thing about invitation codes: what is this code worth.
 *
 * Unauthenticated because the caller has not got an account yet — that is the
 * point. The landing page and the sign-up form call it to say "your $100 credit
 * is ready" before the visitor commits to anything (SUP-140).
 *
 * It lives under `/v1` because the contract names it there, and it is the only
 * `/v1` path that is neither OpenAI-compatible nor API-key authenticated. Two
 * consequences are load-bearing:
 *
 *  - it is registered before `V1FallbackController`, which claims everything
 *    under `/v1`; `RestApiModule` and the e2e suite both pin that order;
 *  - it answers Nest's ordinary JSON error shape rather than the OpenAI envelope,
 *    because no OpenAI client will ever call it.
 *
 * Rate-limited per source address on its own budget: guessing a 59-bit code is
 * hopeless at thirty tries a minute, and the endpoint must not become a way to
 * enumerate a campaign.
 */
@ApiTags('invites')
@Controller('v1/invites')
export class InvitesController {
  constructor(
    private readonly invites: InvitesService,
    @Inject(routerConfig.KEY) private readonly config: ConfigType<typeof routerConfig>,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
  ) {}

  @Get(':code')
  // A grant that has just been spent must not keep reading as available from a
  // CDN or a browser cache.
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'What an invitation code grants, or that it cannot be used.' })
  async lookup(@Param('code') code: string, @Res({ passthrough: true }) response: Response): Promise<InviteLookupDto> {
    await this.admit(response);

    const result = await this.invites.lookup(code);
    return result.valid
      ? { valid: true, grantMicros: String(result.grantMicros), campaign: result.campaign }
      : { valid: false, reason: 'unavailable' };
  }

  /**
   * Charges one lookup against the caller's minute budget.
   *
   * `request.ip` is Express's, so it already honours the single trusted proxy
   * `configureApp` sets up; a deployment behind two would be limiting the wrong
   * address, which is a proxy configuration bug rather than something to guess at
   * here.
   */
  private async admit(response: Response): Promise<void> {
    const ip = response.req.ip ?? 'unknown';
    const decision = await this.limiter.consume(`invite:ip:${ip}`, {
      cost: 1,
      limitPerMinute: this.config.invites.lookupsPerMinute,
    });
    if (!decision.allowed) {
      response.setHeader('Retry-After', String(decision.retryAfterSeconds));
      throw new InviteRateLimitedError();
    }
  }
}
