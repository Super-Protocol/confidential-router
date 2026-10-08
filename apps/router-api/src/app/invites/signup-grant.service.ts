import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { LedgerService } from '../billing/index.js';
import { routerConfig } from '../config.js';

/**
 * `reference` on the ledger entry a sign-up grant writes.
 *
 * The Credits screen reads it to name the row: a sign-up grant and an
 * invitation grant are both `kind: grant`, and an account that got both would
 * otherwise see two identical badges.
 */
export const SIGNUP_GRANT_REFERENCE = 'signup';

export type SignUpGrantOutcome =
  | { status: 'granted'; grantMicros: number; creditTransactionId: string }
  /** This account already had its sign-up grant; nothing was written. */
  | { status: 'replayed'; creditTransactionId: string }
  /** `billing.signupGrantMicros` is 0. */
  | { status: 'disabled' }
  | { status: 'refused'; reason: 'error' };

/**
 * The operator-configured credit every new account gets at registration
 * (SUP-249, listing parameter `signupGrantUsd`).
 *
 * Same shape as the invitation grant and the same guarantees, through the same
 * append-only ledger path — not the billing/purchase path, so none of SUP-167's
 * no-minting rules move: the amount is fixed at deploy time and the only caller
 * is account creation, which nobody can replay for an account that exists.
 *
 * "Once per account" is the ledger's unique `idempotencyKey`, `signup:<userId>`:
 * a retried hook, or two creations racing for the same user, collapse onto the
 * first row. Never throws, for the same reason the invitation grant does not —
 * a failed credit must not fail the registration that triggered it.
 */
@Injectable()
export class SignUpGrantService {
  private readonly logger = new Logger(SignUpGrantService.name);

  constructor(
    @Inject(routerConfig.KEY) private readonly config: ConfigType<typeof routerConfig>,
    private readonly ledger: LedgerService,
  ) {}

  async grantOnSignUp(input: { userId: string; workspaceId: string }): Promise<SignUpGrantOutcome> {
    const grantMicros = this.config.billing.signupGrantMicros;
    if (grantMicros <= 0) {
      return { status: 'disabled' };
    }
    try {
      const entry = await this.ledger.record({
        workspaceId: input.workspaceId,
        kind: 'grant',
        amountMicros: grantMicros,
        reference: SIGNUP_GRANT_REFERENCE,
        description: 'Credit granted at sign-up',
        idempotencyKey: `signup:${input.userId}`,
      });
      if (entry.replayed) {
        return { status: 'replayed', creditTransactionId: entry.transaction.id };
      }
      this.logger.log(`Sign-up grant applied to user ${input.userId}: ${grantMicros} micro-USD credited.`);
      return { status: 'granted', grantMicros, creditTransactionId: entry.transaction.id };
    } catch (error) {
      this.logger.error(
        `Sign-up grant failed for user ${input.userId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { status: 'refused', reason: 'error' };
    }
  }
}
