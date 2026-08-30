import { Injectable, Logger } from '@nestjs/common';
// Type-only: the token lives with the interface in `metering`, and importing it
// for its value here would make the two modules depend on each other at runtime.
import type { CreditsDebit, CreditsGateway } from '../metering/credits.gateway.js';
import { AutoTopUpService } from './auto-top-up.service.js';
import { type CreditsBalance, LedgerService } from './ledger.service.js';

/**
 * The real accounting behind `/v1`'s credit questions.
 *
 * SUP-73 introduced this seam with a placeholder that read the balance and threw
 * the debit away, because writing `balanceMicros` without the matching ledger row
 * would break the invariant that the two agree. `MeteringModule` binds this class
 * under `CREDITS_GATEWAY`, so a served generation now writes a `usage` row and
 * moves the balance in one transaction.
 */
@Injectable()
export class LedgerCreditsGateway implements CreditsGateway {
  private readonly logger = new Logger(LedgerCreditsGateway.name);

  constructor(
    private readonly ledger: LedgerService,
    private readonly autoTopUp: AutoTopUpService,
  ) {}

  balanceOf(workspaceId: string): Promise<CreditsBalance> {
    return this.ledger.balanceOf(workspaceId);
  }

  /**
   * Debits one generation and, if that took the workspace under its automatic
   * top-up threshold, tops it up.
   *
   * The top-up is deliberately not awaited: it may call the payment provider
   * over the network, and a generation that has already been served must not
   * wait on a card. It is safe to run detached — the claim in `AutoTopUpService`
   * makes concurrent calls collapse to one charge.
   */
  async debit(input: CreditsDebit): Promise<void> {
    const entry = await this.ledger.debitGeneration(input);
    if (!entry || entry.replayed) {
      return;
    }
    void this.autoTopUp
      .consider(input.workspaceId)
      .catch((error: unknown) =>
        this.logger.error(
          `Automatic top-up check failed for workspace ${input.workspaceId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
  }
}
