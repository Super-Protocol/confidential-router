import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import Stripe from 'stripe';
import { routerConfig } from '../config.js';
import { centsToMicros, microsToCents, microsToUsdString } from './money.js';
import type {
  CheckoutRequest,
  CheckoutSession,
  LedgerEvent,
  PaymentProvider,
  SavedCharge,
} from './payment-provider.js';

/**
 * Marks the payment intents this service started off-session, so the webhook can
 * tell an automatic top-up from the payment behind a checkout the user drove.
 * Without it both would arrive as `payment_intent.succeeded` and be credited twice.
 */
export const AUTO_TOPUP_METADATA_KEY = 'cr_auto_topup';

export const WORKSPACE_METADATA_KEY = 'cr_workspace_id';

/** Stripe events this provider translates. Everything else is acknowledged and ignored. */
const HANDLED_EVENTS = new Set(['checkout.session.completed', 'payment_intent.succeeded', 'charge.refunded']);

@Injectable()
export class StripePaymentProvider implements PaymentProvider {
  readonly name = 'stripe';
  readonly supportsSavedPaymentMethods = true;

  private readonly logger = new Logger(StripePaymentProvider.name);
  private readonly stripe: Stripe;
  private readonly webhookSecret: string;
  private readonly currency: string;

  constructor(@Inject(routerConfig.KEY) config: ConfigType<typeof routerConfig>, stripe?: Stripe) {
    const settings = config.billing.stripe;
    if (!settings) {
      throw new Error('billing.stripe is not configured.');
    }
    this.webhookSecret = settings.webhookSecret;
    this.currency = settings.currency;
    this.stripe = stripe ?? new Stripe(settings.secretKey);
  }

  /**
   * A one-off Checkout Session. `setup_future_usage: off_session` is what makes
   * auto top-up possible later: it saves the card against the customer at the
   * same time as taking the payment, so the user is never asked for it twice.
   */
  async createCheckout(request: CheckoutRequest): Promise<CheckoutSession> {
    const session = await this.stripe.checkout.sessions.create({
      mode: 'payment',
      client_reference_id: request.workspaceId,
      customer: request.customerRef ?? undefined,
      customer_email: request.customerRef ? undefined : (request.email ?? undefined),
      customer_creation: request.customerRef ? undefined : 'always',
      success_url: request.successUrl,
      cancel_url: request.cancelUrl,
      metadata: { [WORKSPACE_METADATA_KEY]: request.workspaceId },
      payment_intent_data: {
        setup_future_usage: 'off_session',
        metadata: { [WORKSPACE_METADATA_KEY]: request.workspaceId },
      },
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: this.currency,
            unit_amount: microsToCents(request.amountMicros),
            product_data: {
              name: 'Confidential Router credits',
              description: `$${microsToUsdString(request.amountMicros)} of prepaid credits`,
            },
          },
        },
      ],
    });

    if (!session.url) {
      throw new Error(`Stripe returned checkout session ${session.id} without a URL.`);
    }
    return { url: session.url, ref: session.id };
  }

  async handleWebhook(rawBody: Buffer, signature: string | undefined): Promise<LedgerEvent[]> {
    if (!signature) {
      throw new UnauthorizedException('Missing Stripe signature.');
    }

    let event: Stripe.Event;
    try {
      event = await this.stripe.webhooks.constructEventAsync(rawBody, signature, this.webhookSecret);
    } catch (error) {
      // Deliberately not logged with the body: an unverified payload is
      // attacker-controlled and does not belong in the log.
      this.logger.warn(`Rejected a Stripe webhook: ${error instanceof Error ? error.message : String(error)}`);
      throw new UnauthorizedException('Invalid Stripe signature.');
    }

    if (!HANDLED_EVENTS.has(event.type)) {
      return [];
    }

    switch (event.type) {
      case 'checkout.session.completed':
        return this.fromCheckout(event.data.object);
      case 'payment_intent.succeeded':
        return this.fromAutoTopUp(event.data.object);
      case 'charge.refunded':
        return this.fromRefund(event.data.object);
      default:
        return [];
    }
  }

  /**
   * Charges the card saved at the first checkout.
   *
   * The Stripe-side idempotency key is the ledger's own, so a retry of this call
   * cannot create a second payment intent — and the `payment_intent.succeeded`
   * webhook that follows carries the same key into the ledger, so the
   * synchronous and asynchronous paths collapse onto one row.
   */
  async chargeSaved(charge: SavedCharge): Promise<LedgerEvent | null> {
    const paymentMethod = await this.defaultPaymentMethod(charge.customerRef);
    if (!paymentMethod) {
      this.logger.warn(`Customer ${charge.customerRef} has no saved payment method; skipping automatic top-up.`);
      return null;
    }

    const intent = await this.stripe.paymentIntents.create(
      {
        amount: microsToCents(charge.amountMicros),
        currency: this.currency,
        customer: charge.customerRef,
        payment_method: paymentMethod,
        off_session: true,
        confirm: true,
        metadata: { [AUTO_TOPUP_METADATA_KEY]: 'true', [WORKSPACE_METADATA_KEY]: charge.workspaceId },
      },
      { idempotencyKey: charge.idempotencyKey },
    );

    if (intent.status !== 'succeeded') {
      this.logger.log(`Automatic top-up ${intent.id} is ${intent.status}; the webhook will settle it.`);
      return null;
    }
    return {
      workspaceId: charge.workspaceId,
      kind: 'auto_topup',
      amountMicros: centsToMicros(intent.amount_received || intent.amount),
      reference: intent.id,
      idempotencyKey: charge.idempotencyKey,
      description: charge.description ?? `Automatic top-up of $${microsToUsdString(charge.amountMicros)}`,
      customerRef: charge.customerRef,
    };
  }

  private fromCheckout(session: Stripe.Checkout.Session): LedgerEvent[] {
    const workspaceId = session.client_reference_id ?? session.metadata?.[WORKSPACE_METADATA_KEY];
    if (!workspaceId || session.payment_status !== 'paid' || !session.amount_total) {
      return [];
    }
    const paymentIntent = idOf(session.payment_intent) ?? session.id;
    return [
      {
        workspaceId,
        kind: 'purchase',
        amountMicros: centsToMicros(session.amount_total),
        reference: paymentIntent,
        // Keyed on the payment, not on the event: Stripe emits several events
        // per payment and retries each of them, and only the payment is the
        // thing that happened once.
        idempotencyKey: `stripe:payment:${paymentIntent}`,
        description: `Credit purchase of $${microsToUsdString(centsToMicros(session.amount_total))}`,
        customerRef: idOf(session.customer),
      },
    ];
  }

  private fromAutoTopUp(intent: Stripe.PaymentIntent): LedgerEvent[] {
    // A checkout's payment intent also lands here; crediting it would double the
    // purchase `checkout.session.completed` already reported.
    if (intent.metadata?.[AUTO_TOPUP_METADATA_KEY] !== 'true') {
      return [];
    }
    const workspaceId = intent.metadata?.[WORKSPACE_METADATA_KEY];
    if (!workspaceId) {
      this.logger.warn(`Automatic top-up ${intent.id} has no workspace metadata; ignoring.`);
      return [];
    }
    const amountMicros = centsToMicros(intent.amount_received || intent.amount);
    return [
      {
        workspaceId,
        kind: 'auto_topup',
        amountMicros,
        reference: intent.id,
        idempotencyKey: `stripe:payment:${intent.id}`,
        description: `Automatic top-up of $${microsToUsdString(amountMicros)}`,
        customerRef: idOf(intent.customer),
      },
    ];
  }

  private fromRefund(charge: Stripe.Charge): LedgerEvent[] {
    const workspaceId = charge.metadata?.[WORKSPACE_METADATA_KEY];
    if (!workspaceId || !charge.amount_refunded) {
      return [];
    }
    const amountMicros = centsToMicros(charge.amount_refunded);
    return [
      {
        workspaceId,
        kind: 'refund',
        amountMicros: -amountMicros,
        reference: charge.id,
        // The refunded total is cumulative, so the key has to include it: a
        // second partial refund of the same charge is a different event.
        idempotencyKey: `stripe:refund:${charge.id}:${charge.amount_refunded}`,
        description: `Refund of $${microsToUsdString(amountMicros)}`,
        customerRef: idOf(charge.customer),
      },
    ];
  }

  private async defaultPaymentMethod(customerRef: string): Promise<string | null> {
    const customer = await this.stripe.customers.retrieve(customerRef);
    if (customer.deleted) {
      return null;
    }
    const saved = idOf(customer.invoice_settings?.default_payment_method);
    if (saved) {
      return saved;
    }
    const methods = await this.stripe.paymentMethods.list({ customer: customerRef, type: 'card', limit: 1 });
    return methods.data[0]?.id ?? null;
  }
}

/** Stripe returns either an id or the expanded object; billing only ever wants the id. */
function idOf(value: string | { id: string } | null | undefined): string | null {
  if (!value) {
    return null;
  }
  return typeof value === 'string' ? value : value.id;
}
