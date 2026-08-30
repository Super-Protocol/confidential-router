import { Inject, Injectable, Logger } from '@nestjs/common';
import { BillingService } from './billing.service.js';
import { microsToUsdString } from './money.js';
import { PAYMENT_PROVIDER, type PaymentProvider } from './payment-provider.js';

export type AutoTopUpOutcome =
  | { charged: false; reason: 'disabled' | 'above-threshold' | 'cooling-down' | 'no-payment-method' | 'failed' }
  | { charged: true; amountMicros: number };

/**
 * Tops a workspace up from its saved card when the balance falls under the
 * threshold (ADR-005 §4).
 *
 * Two things have to be true of this, and both are enforced by the same atomic
 * claim rather than by a lock: it must not charge twice for one dip below the
 * threshold, and a *failing* card must not turn into one charge attempt per
 * request. Writing `autoTopUpLastAt` before talking to the provider — with the
 * cooldown in the `WHERE` clause, so only one caller can win — buys both.
 */
@Injectable()
export class AutoTopUpService {
  private readonly logger = new Logger(AutoTopUpService.name);

  constructor(
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly billing: BillingService,
  ) {}

  /**
   * Called after a debit. Cheap and safe to call on every generation: everything
   * but the charge itself is one indexed read.
   */
  async consider(workspaceId: string, now = new Date()): Promise<AutoTopUpOutcome> {
    const workspace = await this.billing.workspace(workspaceId);
    if (
      !workspace?.autoTopUpEnabled ||
      workspace.autoTopUpThresholdMicros === null ||
      workspace.autoTopUpAmountMicros === null ||
      !this.provider.supportsSavedPaymentMethods
    ) {
      return { charged: false, reason: 'disabled' };
    }
    if (workspace.balanceMicros >= workspace.autoTopUpThresholdMicros) {
      return { charged: false, reason: 'above-threshold' };
    }
    if (!workspace.stripeCustomerId) {
      // The card is saved by the first checkout; until then there is nothing to
      // charge and saying so once per cooldown is the useful signal.
      this.logger.warn(`Workspace ${workspaceId} wants automatic top-up but has never completed a checkout.`);
      return { charged: false, reason: 'no-payment-method' };
    }

    const claim = await this.billing.claimAutoTopUp(workspaceId, now);
    if (!claim) {
      return { charged: false, reason: 'cooling-down' };
    }

    const amountMicros = workspace.autoTopUpAmountMicros;
    try {
      const event = await this.provider.chargeSaved({
        workspaceId,
        customerRef: workspace.stripeCustomerId,
        amountMicros,
        idempotencyKey: `autotopup:${workspaceId}:${claim}`,
        description: `Automatic top-up of $${microsToUsdString(amountMicros)}`,
      });
      if (!event) {
        // The provider will confirm out of band; the webhook credits the same
        // idempotency key, so this is not a lost top-up.
        return { charged: false, reason: 'no-payment-method' };
      }
      await this.billing.apply([event]);
      this.logger.log(`Automatically topped workspace ${workspaceId} up by $${microsToUsdString(amountMicros)}.`);
      return { charged: true, amountMicros };
    } catch (error) {
      // The claim stands: a card that declines must not be retried on the very
      // next request. The cooldown is exactly the back-off we want here.
      this.logger.error(
        `Automatic top-up failed for workspace ${workspaceId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { charged: false, reason: 'failed' };
    }
  }
}
