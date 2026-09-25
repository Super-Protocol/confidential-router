import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Too many lookups from one address.
 *
 * Its own exception rather than the OpenAI `rate_limit_error` envelope `/v1`
 * uses: the caller here is a landing page, not an SDK, and Nest's ordinary JSON
 * error is what it can read.
 */
export class InviteRateLimitedError extends HttpException {
  constructor() {
    super('Too many invitation lookups. Try again shortly.', HttpStatus.TOO_MANY_REQUESTS);
    this.name = 'InviteRateLimitedError';
  }
}
