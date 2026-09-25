import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Too many console events from one address.
 *
 * Nest's ordinary JSON error rather than the OpenAI `rate_limit_error` envelope
 * `/v1` uses, for the same reason `InviteRateLimitedError` is: the caller is the
 * console's own `fetch`, not an SDK.
 */
export class AnalyticsRateLimitedError extends HttpException {
  constructor() {
    super('Too many analytics events. Try again shortly.', HttpStatus.TOO_MANY_REQUESTS);
    this.name = 'AnalyticsRateLimitedError';
  }
}
