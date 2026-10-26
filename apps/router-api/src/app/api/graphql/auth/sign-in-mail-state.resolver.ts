import { HttpException, HttpStatus, Inject } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Args, Context, Query, Resolver } from '@nestjs/graphql';
import type { Request } from 'express';
import { routerConfig } from '../../../config.js';
import { MailDeliveryService } from '../../../mail/mail-delivery.service.js';
import { MAIL_RATE_LIMITER } from '../../../mail/mail-rate-limiter.js';
import type { RateLimiter } from '../../v1/rate-limiter.js';
import { SignInMailStateModel, SignInMailStateName } from './sign-in-mail-state.model.js';

/** Too many lookups from one source address. */
class MailStateRateLimitedError extends HttpException {
  constructor() {
    super('Too many lookups. Try again shortly.', HttpStatus.TOO_MANY_REQUESTS);
    this.name = 'MailStateRateLimitedError';
  }
}

/**
 * Whether a sign-in code can reach the address the viewer just typed
 * (SUP-551).
 *
 * The code-entry screen tells people that mail is only ever late — check spam,
 * an address is mailed a limited number of codes an hour. For an address on the
 * provider's suppression list every clause of that is false: it is not in spam,
 * waiting will not help, and pressing "send a new code" produces another
 * message the relay accepts and discards. This query is what lets the screen
 * stop saying it.
 *
 * **Public, and not an account-existence oracle.** Everything it reports is
 * about the *mailbox* — our provider is dropping mail to it — and nothing about
 * whether an account here holds it: an invited stranger's typo and a long-time
 * user's address answer identically, and so do two addresses with no account at
 * all. The underlying fact is one anyone can produce for any address by asking
 * for a code and watching their own mail server refuse it, which is why
 * answering it costs us nothing we were keeping.
 *
 * What it does expose is a list of addresses our provider has suppressed, one
 * lookup at a time — hence the budget, which is the mail feature's own and not
 * `/v1`'s.
 */
@Resolver(() => SignInMailStateModel)
export class SignInMailStateResolver {
  constructor(
    private readonly deliveries: MailDeliveryService,
    @Inject(routerConfig.KEY) private readonly config: ConfigType<typeof routerConfig>,
    @Inject(MAIL_RATE_LIMITER) private readonly limiter: RateLimiter,
  ) {}

  @Query(() => SignInMailStateModel, {
    name: 'signInMailState',
    description:
      'Whether this deployment’s mail provider is dropping messages to an address. Public, and says nothing ' +
      'about whether an account holds it.',
  })
  async signInMailState(
    @Args('email', { type: () => String, description: 'The address a code was asked for.' }) email: string,
    @Context() context: { req?: Request },
  ): Promise<SignInMailStateModel> {
    await this.admit(context.req?.ip ?? 'unknown');
    const verdict = await this.deliveries.verdictOf(email);
    return {
      state: STATE_NAMES[verdict.state],
      ...(verdict.since && verdict.state !== 'unknown' ? { since: verdict.since.toISOString() } : {}),
    };
  }

  private async admit(ip: string): Promise<void> {
    const decision = await this.limiter.consume(`mail-state:ip:${ip}`, {
      cost: 1,
      limitPerMinute: this.config.mail.stateLookupsPerMinute,
    });
    if (!decision.allowed) {
      throw new MailStateRateLimitedError();
    }
  }
}

const STATE_NAMES = {
  unknown: SignInMailStateName.UNKNOWN,
  rejecting: SignInMailStateName.REJECTING,
  delayed: SignInMailStateName.DELAYED,
  delivering: SignInMailStateName.DELIVERING,
} as const;
