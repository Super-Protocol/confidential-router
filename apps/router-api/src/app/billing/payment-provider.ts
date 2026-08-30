import type { CreditTransactionKind } from '../db/entities/credit-transaction.entity.js';

/** Injection token for the configured `PaymentProvider`. */
export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

export interface CheckoutRequest {
  workspaceId: string;
  /** Positive micro-USD; must be a whole number of cents. */
  amountMicros: number;
  /** Existing customer at the provider, when this workspace has bought before. */
  customerRef?: string | null;
  email?: string | null;
  successUrl: string;
  cancelUrl: string;
}

export interface CheckoutSession {
  /** Where to send the browser to pay. */
  url: string;
  /** The provider's own id for the session, for support and reconciliation. */
  ref: string;
}

/**
 * A money movement the provider has confirmed, in the ledger's own vocabulary.
 *
 * The provider never touches the ledger itself: it translates its own events
 * into these, and `BillingService` is the only thing that writes them. That is
 * what keeps webhook handling (untrusted input, retried at will) separate from
 * the invariant that the balance equals the sum of the ledger.
 */
export interface LedgerEvent {
  workspaceId: string;
  kind: CreditTransactionKind;
  /** Signed, in the ledger's convention: a purchase is positive, a refund negative. */
  amountMicros: number;
  /** Provider object id (payment intent, refund, …). */
  reference: string;
  /** Stable per real-world event; a redelivery must produce the same key. */
  idempotencyKey: string;
  description?: string | null;
  /** Set when the event told us which customer to charge next time. */
  customerRef?: string | null;
}

export interface SavedCharge {
  workspaceId: string;
  /** The provider-side customer whose saved method gets charged. */
  customerRef: string;
  amountMicros: number;
  idempotencyKey: string;
  description?: string | null;
}

/**
 * Everything billing needs from a payment processor (ADR-005 §4).
 *
 * Two implementations: `StripePaymentProvider` in production and
 * `ManualPaymentProvider` for development and e2e, where reaching Stripe is
 * neither possible nor desirable.
 */
export interface PaymentProvider {
  readonly name: string;

  /** Whether `chargeSaved` can work — i.e. whether auto top-up is available at all. */
  readonly supportsSavedPaymentMethods: boolean;

  createCheckout(request: CheckoutRequest): Promise<CheckoutSession>;

  /**
   * Verifies and translates one webhook delivery. Anything the provider sends
   * that billing does not care about yields an empty array, never an error —
   * a 200 with nothing to do is how a webhook endpoint stops a provider from
   * retrying events it will never handle.
   */
  handleWebhook(rawBody: Buffer, signature: string | undefined): Promise<LedgerEvent[]>;

  /**
   * Charges the payment method saved at the first checkout, off-session.
   *
   * Returns the event when the charge settled synchronously, and `null` when the
   * provider will confirm asynchronously — the webhook then credits the same
   * `idempotencyKey`, so the two paths can never both count.
   */
  chargeSaved(charge: SavedCharge): Promise<LedgerEvent | null>;
}
