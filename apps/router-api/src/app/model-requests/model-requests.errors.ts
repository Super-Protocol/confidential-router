import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * This account has filed its allowance of requests for the day.
 *
 * A 429 rather than a silent success: someone who is told nothing submits
 * again, which is exactly the traffic the limit exists to stop. The message
 * names the window so the console can say when they may come back.
 */
export class ModelRequestRateLimitedError extends HttpException {
  constructor(perDay: number) {
    super(
      `You have already requested ${perDay} model${perDay === 1 ? '' : 's'} today. ` +
        'Requests reset 24 hours after each one — the ones you sent are recorded.',
      HttpStatus.TOO_MANY_REQUESTS,
    );
    this.name = 'ModelRequestRateLimitedError';
  }
}
