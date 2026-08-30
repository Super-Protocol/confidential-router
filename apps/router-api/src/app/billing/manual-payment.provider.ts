import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { type SignedLinkClaims, signLink, verifyLink } from '../common/signed-link.js';
import { routerConfig } from '../config.js';
import { centsToMicros, microsToCents, microsToUsdString } from './money.js';
import type {
  CheckoutRequest,
  CheckoutSession,
  LedgerEvent,
  PaymentProvider,
  SavedCharge,
} from './payment-provider.js';

/** Audience of the token that stands in for a Stripe Checkout Session. */
export const MANUAL_CHECKOUT_AUDIENCE = 'billing:manual-checkout';

/** How long a manual checkout link stays usable. */
const CHECKOUT_TTL_MS = 60 * 60 * 1000;

export interface ManualCheckoutClaims extends SignedLinkClaims {
  workspaceId: string;
  cents: number;
  ref: string;
  successUrl: string;
}

/**
 * The development and e2e payment provider (ADR-005 §4).
 *
 * It models the *shape* of a real checkout rather than pretending to be one:
 * `createCheckout` hands back a link, following that link is the "payment", and
 * the redirect target credits the ledger — the same
 * redirect-then-confirm sequence Stripe drives, so an e2e test exercises the
 * whole path without a network.
 *
 * The link is HMAC-signed with `auth.secret` and expires. Without that, the
 * confirm endpoint would be an unauthenticated way to mint credit; with it, a
 * caller can only complete a checkout this process actually created.
 * `BillingModule` additionally refuses to bind this provider in production.
 */
@Injectable()
export class ManualPaymentProvider implements PaymentProvider {
  readonly name = 'manual';
  readonly supportsSavedPaymentMethods = true;

  private readonly logger = new Logger(ManualPaymentProvider.name);

  constructor(@Inject(routerConfig.KEY) private readonly config: ConfigType<typeof routerConfig>) {}

  async createCheckout(request: CheckoutRequest): Promise<CheckoutSession> {
    const cents = microsToCents(request.amountMicros);
    const ref = `manual_cs_${randomUUID()}`;
    const token = signLink(
      this.config.auth.secret,
      { aud: MANUAL_CHECKOUT_AUDIENCE, workspaceId: request.workspaceId, cents, ref, successUrl: request.successUrl },
      { ttlMs: CHECKOUT_TTL_MS },
    );
    const url = new URL('/billing/manual/complete', this.config.server.publicBaseUrl);
    url.searchParams.set('token', token);
    this.logger.log(`Manual checkout ${ref} for workspace ${request.workspaceId}: ${url}`);
    return { url: url.toString(), ref };
  }

  /**
   * Turns a completed manual checkout link into the credit it stands for.
   *
   * Called by the confirm endpoint rather than by a webhook, which is the one
   * structural difference from Stripe: there is no second party to call back.
   */
  completeCheckout(token: string): { event: LedgerEvent; successUrl: string } {
    const claims = verifyLink<ManualCheckoutClaims>(this.config.auth.secret, token, {
      audience: MANUAL_CHECKOUT_AUDIENCE,
    });
    const amountMicros = centsToMicros(claims.cents);
    return {
      successUrl: claims.successUrl,
      event: {
        workspaceId: claims.workspaceId,
        kind: 'purchase',
        amountMicros,
        reference: claims.ref,
        idempotencyKey: `manual:${claims.ref}`,
        description: `Manual top-up of $${microsToUsdString(amountMicros)}`,
        customerRef: `manual_cus_${claims.workspaceId}`,
      },
    };
  }

  /** Nothing to verify and nothing to translate: this provider has no webhook. */
  async handleWebhook(): Promise<LedgerEvent[]> {
    return [];
  }

  async chargeSaved(charge: SavedCharge): Promise<LedgerEvent> {
    return {
      workspaceId: charge.workspaceId,
      kind: 'auto_topup',
      amountMicros: charge.amountMicros,
      reference: `manual_pi_${randomUUID()}`,
      idempotencyKey: charge.idempotencyKey,
      description: charge.description ?? `Automatic top-up of $${microsToUsdString(charge.amountMicros)}`,
      customerRef: charge.customerRef,
    };
  }
}
