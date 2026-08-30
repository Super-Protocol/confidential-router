import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { testConfig } from '../../../test/seed.js';
import { ManualPaymentProvider } from './manual-payment.provider.js';
import { InvalidMicroAmountError } from './money.js';

const config = testConfig();

function provider(): ManualPaymentProvider {
  return new ManualPaymentProvider(config);
}

async function checkoutToken(amountMicros = 20_000_000): Promise<string> {
  const session = await provider().createCheckout({
    workspaceId: 'ws-1',
    amountMicros,
    successUrl: 'http://localhost:4200/credits?topup=success',
    cancelUrl: 'http://localhost:4200/credits?topup=cancelled',
  });
  return new URL(session.url).searchParams.get('token') ?? '';
}

describe('the manual checkout round trip', () => {
  it('turns a completed link into the purchase it stands for', async () => {
    const { event } = provider().completeCheckout(await checkoutToken());

    expect(event).toMatchObject({
      workspaceId: 'ws-1',
      kind: 'purchase',
      amountMicros: 20_000_000,
    });
    expect(event.idempotencyKey).toMatch(/^manual:manual_cs_/);
  });

  it('sends the browser back to where the checkout started', async () => {
    const { successUrl } = provider().completeCheckout(await checkoutToken());

    expect(successUrl).toBe('http://localhost:4200/credits?topup=success');
  });

  it('is idempotent by construction: one link, one key', async () => {
    const token = await checkoutToken();

    expect(provider().completeCheckout(token).event.idempotencyKey).toBe(
      provider().completeCheckout(token).event.idempotencyKey,
    );
  });

  it('refuses a link nobody signed', () => {
    expect(() => provider().completeCheckout('made.up')).toThrow(UnauthorizedException);
  });

  it('refuses an amount that is not a whole number of cents', async () => {
    await expect(
      provider().createCheckout({
        workspaceId: 'ws-1',
        amountMicros: 5_450,
        successUrl: 'http://localhost:4200/',
        cancelUrl: 'http://localhost:4200/',
      }),
    ).rejects.toThrow(InvalidMicroAmountError);
  });
});

describe('charging the saved method', () => {
  it('reports an automatic top-up against the key it was asked to use', async () => {
    const event = await provider().chargeSaved({
      workspaceId: 'ws-1',
      customerRef: 'manual_cus_ws-1',
      amountMicros: 10_000_000,
      idempotencyKey: 'autotopup:ws-1:1',
    });

    expect(event).toMatchObject({ workspaceId: 'ws-1', kind: 'auto_topup', idempotencyKey: 'autotopup:ws-1:1' });
  });
});

describe('the webhook', () => {
  it('has nothing to report: this provider has no second party', async () => {
    expect(await provider().handleWebhook()).toEqual([]);
  });
});
