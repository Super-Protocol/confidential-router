import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { InMemoryTokenBucketRateLimiter } from '../api/v1/rate-limiter.js';
import { routerConfig } from '../config.js';

/** Better Auth's two email-code routes, relative to `/auth`. */
export const EMAIL_CODE_SEND_PATH = '/email-otp/send-verification-otp';
export const EMAIL_CODE_SIGN_IN_PATH = '/sign-in/email-otp';

/**
 * Per-source-address budgets on the two email-code routes (SUP-269): asking
 * for a code, and trying one.
 *
 * Express middleware in front of Better Auth rather than a Better Auth hook,
 * because the source address is Express's — `request.ip` already honours the
 * single trusted proxy `configureApp` sets up — and because this has to run
 * before Better Auth reads the body: a refused request should cost nothing.
 *
 * Two buckets, not one, so that somebody hammering the send route cannot spend
 * the budget an honest visitor behind the same address needs to type the code
 * they were just mailed. The refusal is a 429 whatever address was named, so it
 * says nothing about whether that address has an account.
 *
 * Neither is the whole defence. A code also dies after `auth.emailCode.attempts`
 * wrong guesses whoever makes them, and one recipient is mailed at most
 * `mailsPerAddressPerHour` codes — that one silently, in `MailService`.
 */
@Injectable()
export class EmailCodeThrottle {
  private readonly limiter = new InMemoryTokenBucketRateLimiter();

  constructor(@Inject(routerConfig.KEY) private readonly config: ConfigType<typeof routerConfig>) {}

  readonly send: RequestHandler = this.guard('send', 'Too many sign-in codes requested. Try again in a minute.');
  readonly signIn: RequestHandler = this.guard('sign-in', 'Too many sign-in attempts. Try again in a minute.');

  /** Test seam, as on the limiter itself. */
  reset(): void {
    this.limiter.reset();
  }

  private guard(bucket: string, message: string): RequestHandler {
    return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
      if (request.method !== 'POST') {
        next();
        return;
      }
      const decision = await this.limiter.consume(`email-code:${bucket}:ip:${request.ip ?? 'unknown'}`, {
        cost: 1,
        limitPerMinute: this.config.auth.emailCode.requestsPerMinute,
      });
      if (decision.allowed) {
        next();
        return;
      }
      response
        .status(429)
        .set('Retry-After', String(decision.retryAfterSeconds))
        .json({ code: 'RATE_LIMITED', message });
    };
  }
}
