import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { LedgerEvent, PaymentProvider } from './payment-provider.js';

/** What every path through this provider says, so the console can quote one sentence. */
export const PURCHASES_DISABLED_MESSAGE = 'Buying credits is switched off on this deployment.';

/**
 * The provider for a deployment that does not sell credit (SUP-167).
 *
 * It is what `billing.provider: disabled` binds, and it exists because the
 * alternative was worse: with no Stripe credentials the module used to fall back
 * to the manual provider, which mints credit from a signed link, so a deployment
 * whose terms say buying is not switched on yet was handing every account an
 * unbounded top-up button.
 *
 * Refusing checkout is the whole behaviour. Credit still arrives — invitation
 * codes, the feedback grant and an operator's `credits grant` all write the
 * ledger directly and never go through a provider.
 */
@Injectable()
export class DisabledPaymentProvider implements PaymentProvider {
  readonly name = 'disabled';
  readonly supportsCheckout = false;
  readonly supportsSavedPaymentMethods = false;

  async createCheckout(): Promise<never> {
    throw new ServiceUnavailableException(PURCHASES_DISABLED_MESSAGE);
  }

  /** No provider to be called back by, and a 200 is what stops one retrying. */
  async handleWebhook(): Promise<LedgerEvent[]> {
    return [];
  }

  async chargeSaved(): Promise<never> {
    throw new ServiceUnavailableException(PURCHASES_DISABLED_MESSAGE);
  }
}
