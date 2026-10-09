import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import type { NextFunction, Request, Response } from 'express';
import { InMemoryTokenBucketRateLimiter } from '../api/v1/rate-limiter.js';
import { routerConfig } from '../config.js';

/** Better Auth's reset-request route, relative to `/auth`. */
export const PASSWORD_RESET_REQUEST_PATH = '/request-password-reset';

/**
 * Per-source-address budget on `POST /auth/request-password-reset`.
 *
 * Express middleware in front of Better Auth rather than a Better Auth hook,
 * because the source address is Express's — `request.ip` already honours the
 * single trusted proxy `configureApp` sets up — and because this has to run
 * before Better Auth reads the body: a refused request should cost nothing.
 *
 * The refusal is a 429 whatever address was asked about, so it says nothing
 * about whether that address has an account. The *per-recipient* allowance is
 * enforced later, in `MailService`, and silently: there the only honest answer
 * that does not enumerate is the same one everybody gets.
 */
@Injectable()
export class PasswordResetThrottle {
  private readonly limiter = new InMemoryTokenBucketRateLimiter();

  constructor(@Inject(routerConfig.KEY) private readonly config: ConfigType<typeof routerConfig>) {}

  readonly middleware = async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    if (request.method !== 'POST') {
      next();
      return;
    }
    const decision = await this.limiter.consume(`password-reset:ip:${request.ip ?? 'unknown'}`, {
      cost: 1,
      limitPerMinute: this.config.auth.passwordReset.requestsPerMinute,
    });
    if (decision.allowed) {
      next();
      return;
    }
    response
      .status(429)
      .set('Retry-After', String(decision.retryAfterSeconds))
      .json({ code: 'RATE_LIMITED', message: 'Too many password reset requests. Try again in a minute.' });
  };

  /** Test seam, as on the limiter itself. */
  reset(): void {
    this.limiter.reset();
  }
}
