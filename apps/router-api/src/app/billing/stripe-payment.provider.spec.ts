import { UnauthorizedException } from '@nestjs/common';
import Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';
import { testConfig } from '../../../test/seed.js';
import { AUTO_TOPUP_METADATA_KEY, StripePaymentProvider, WORKSPACE_METADATA_KEY } from './stripe-payment.provider.js';

/**
 * Stripe is exercised offline: webhook handling is checked against events signed
 * with the configured secret (the SDK's own test-header helper produces exactly
 * what Stripe sends), and the outbound calls against a stubbed client. Nothing
 * here reaches the network.
 */

const SECRET_KEY = 'sk_test_00000000000000000000000000';
const WEBHOOK_SECRET = 'whsec_test_secret';

const config = testConfig({
  CR_API_BILLING__STRIPE__SECRET_KEY: SECRET_KEY,
  CR_API_BILLING__STRIPE__WEBHOOK_SECRET: WEBHOOK_SECRET,
});

const stripe = new Stripe(SECRET_KEY);

function provider(client?: unknown): StripePaymentProvider {
  return new StripePaymentProvider(config, (client ?? stripe) as Stripe);
}

/** One webhook delivery, signed the way Stripe signs it. */
function delivery(type: string, object: unknown, id = 'evt_1'): { body: Buffer; signature: string } {
  const payload = JSON.stringify({ id, object: 'event', type, data: { object } });
  return {
    body: Buffer.from(payload, 'utf8'),
    signature: stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET }),
  };
}

describe('webhook verification', () => {
  it('refuses a delivery with no signature', async () => {
    await expect(provider().handleWebhook(Buffer.from('{}'), undefined)).rejects.toThrow(UnauthorizedException);
  });

  it('refuses a delivery signed with the wrong secret', async () => {
    const payload = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: {} } });
    const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_not_ours' });

    await expect(provider().handleWebhook(Buffer.from(payload), signature)).rejects.toThrow(UnauthorizedException);
  });

  it('refuses a delivery whose body was altered after signing', async () => {
    const { signature } = delivery('checkout.session.completed', { amount_total: 2_000 });

    await expect(
      provider().handleWebhook(Buffer.from(JSON.stringify({ amount_total: 200_000 })), signature),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('acknowledges an event it does not handle without erroring', async () => {
    const { body, signature } = delivery('invoice.paid', {});

    expect(await provider().handleWebhook(body, signature)).toEqual([]);
  });
});

describe('checkout.session.completed', () => {
  const session = {
    id: 'cs_test_1',
    client_reference_id: 'ws-1',
    payment_status: 'paid',
    amount_total: 2_000,
    payment_intent: 'pi_test_1',
    customer: 'cus_test_1',
  };

  it('credits the workspace the session names', async () => {
    const { body, signature } = delivery('checkout.session.completed', session);

    expect(await provider().handleWebhook(body, signature)).toEqual([
      {
        workspaceId: 'ws-1',
        kind: 'purchase',
        amountMicros: 20_000_000,
        reference: 'pi_test_1',
        idempotencyKey: 'stripe:payment:pi_test_1',
        description: 'Credit purchase of $20.000000',
        customerRef: 'cus_test_1',
      },
    ]);
  });

  it('keys the ledger entry on the payment, so two events for it cannot both credit', async () => {
    const first = await provider().handleWebhook(...deliveryArgs('checkout.session.completed', session, 'evt_1'));
    const redelivered = await provider().handleWebhook(...deliveryArgs('checkout.session.completed', session, 'evt_2'));

    expect(redelivered[0].idempotencyKey).toBe(first[0].idempotencyKey);
  });

  it('ignores a session that was not paid', async () => {
    const { body, signature } = delivery('checkout.session.completed', { ...session, payment_status: 'unpaid' });

    expect(await provider().handleWebhook(body, signature)).toEqual([]);
  });

  it('ignores a session with no workspace on it', async () => {
    const { body, signature } = delivery('checkout.session.completed', {
      ...session,
      client_reference_id: null,
      metadata: {},
    });

    expect(await provider().handleWebhook(body, signature)).toEqual([]);
  });
});

describe('payment_intent.succeeded', () => {
  it('credits an off-session top-up this service started', async () => {
    const { body, signature } = delivery('payment_intent.succeeded', {
      id: 'pi_auto_1',
      amount: 1_000,
      amount_received: 1_000,
      customer: 'cus_test_1',
      metadata: { [AUTO_TOPUP_METADATA_KEY]: 'true', [WORKSPACE_METADATA_KEY]: 'ws-1' },
    });

    expect(await provider().handleWebhook(body, signature)).toEqual([
      expect.objectContaining({ kind: 'auto_topup', amountMicros: 10_000_000, workspaceId: 'ws-1' }),
    ]);
  });

  it("ignores a checkout's own payment intent, which the session already credited", async () => {
    const { body, signature } = delivery('payment_intent.succeeded', {
      id: 'pi_test_1',
      amount: 2_000,
      metadata: { [WORKSPACE_METADATA_KEY]: 'ws-1' },
    });

    expect(await provider().handleWebhook(body, signature)).toEqual([]);
  });
});

describe('charge.refunded', () => {
  it('removes the refunded amount, keyed on how much has been refunded so far', async () => {
    const { body, signature } = delivery('charge.refunded', {
      id: 'ch_1',
      amount_refunded: 500,
      customer: 'cus_test_1',
      metadata: { [WORKSPACE_METADATA_KEY]: 'ws-1' },
    });

    expect(await provider().handleWebhook(body, signature)).toEqual([
      expect.objectContaining({
        kind: 'refund',
        amountMicros: -5_000_000,
        idempotencyKey: 'stripe:refund:ch_1:500',
      }),
    ]);
  });
});

describe('createCheckout', () => {
  it('saves the card at the same time as taking the payment', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' });

    const session = await provider({ checkout: { sessions: { create } } }).createCheckout({
      workspaceId: 'ws-1',
      amountMicros: 20_000_000,
      successUrl: 'https://console.example/credits?topup=success',
      cancelUrl: 'https://console.example/credits?topup=cancelled',
    });

    expect(session).toEqual({ url: 'https://checkout.stripe.com/c/pay/cs_test_1', ref: 'cs_test_1' });
    const [request] = create.mock.calls[0];
    expect(request.payment_intent_data.setup_future_usage).toBe('off_session');
    expect(request.client_reference_id).toBe('ws-1');
    expect(request.line_items[0].price_data.unit_amount).toBe(2_000);
  });
});

describe('chargeSaved', () => {
  const customer = { deleted: false, invoice_settings: { default_payment_method: 'pm_1' } };

  it('charges off-session under the ledger key, so the webhook cannot double it', async () => {
    const create = vi
      .fn()
      .mockResolvedValue({ id: 'pi_auto_1', status: 'succeeded', amount: 1_000, amount_received: 1_000 });
    const client = { customers: { retrieve: vi.fn().mockResolvedValue(customer) }, paymentIntents: { create } };

    const event = await provider(client).chargeSaved({
      workspaceId: 'ws-1',
      customerRef: 'cus_test_1',
      amountMicros: 10_000_000,
      idempotencyKey: 'autotopup:ws-1:1756600000000',
    });

    expect(event).toMatchObject({ kind: 'auto_topup', idempotencyKey: 'autotopup:ws-1:1756600000000' });
    const [request, options] = create.mock.calls[0];
    expect(request.off_session).toBe(true);
    expect(request.metadata[AUTO_TOPUP_METADATA_KEY]).toBe('true');
    expect(options.idempotencyKey).toBe('autotopup:ws-1:1756600000000');
  });

  it('reports nothing when the intent has not settled, leaving it to the webhook', async () => {
    const client = {
      customers: { retrieve: vi.fn().mockResolvedValue(customer) },
      paymentIntents: { create: vi.fn().mockResolvedValue({ id: 'pi_auto_2', status: 'requires_action' }) },
    };

    expect(
      await provider(client).chargeSaved({
        workspaceId: 'ws-1',
        customerRef: 'cus_test_1',
        amountMicros: 10_000_000,
        idempotencyKey: 'autotopup:ws-1:2',
      }),
    ).toBeNull();
  });

  it('reports nothing when the customer has no card on file', async () => {
    const client = {
      customers: { retrieve: vi.fn().mockResolvedValue({ deleted: false, invoice_settings: {} }) },
      paymentMethods: { list: vi.fn().mockResolvedValue({ data: [] }) },
      paymentIntents: { create: vi.fn() },
    };

    expect(
      await provider(client).chargeSaved({
        workspaceId: 'ws-1',
        customerRef: 'cus_test_1',
        amountMicros: 10_000_000,
        idempotencyKey: 'autotopup:ws-1:3',
      }),
    ).toBeNull();
    expect(client.paymentIntents.create).not.toHaveBeenCalled();
  });
});

/** `handleWebhook` takes two arguments; this keeps the spread call readable. */
function deliveryArgs(type: string, object: unknown, id: string): [Buffer, string] {
  const { body, signature } = delivery(type, object, id);
  return [body, signature];
}
