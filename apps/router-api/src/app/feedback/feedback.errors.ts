import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * A webhook delivery this deployment did not authenticate.
 *
 * One exception for both failures — a bad provider signature and a missing,
 * forged or expired token — and one message for both, on purpose. The caller is
 * either the form provider, which does not read the body, or someone probing
 * the endpoint, who must not be told which of the two things they got wrong.
 */
export class FeedbackSignatureError extends HttpException {
  constructor() {
    super('The webhook delivery could not be verified.', HttpStatus.UNAUTHORIZED);
    this.name = 'FeedbackSignatureError';
  }
}

/** Too many deliveries from one address. */
export class FeedbackRateLimitedError extends HttpException {
  constructor() {
    super('Too many webhook deliveries. Try again shortly.', HttpStatus.TOO_MANY_REQUESTS);
    this.name = 'FeedbackRateLimitedError';
  }
}
