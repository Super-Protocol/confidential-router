import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { DisabledPaymentProvider } from './disabled-payment.provider.js';

describe('DisabledPaymentProvider', () => {
  const provider = new DisabledPaymentProvider();

  it('advertises that it sells nothing, which is what the console reads', () => {
    expect(provider.supportsCheckout).toBe(false);
    expect(provider.supportsSavedPaymentMethods).toBe(false);
  });

  it('refuses a checkout instead of handing back a link', async () => {
    await expect(provider.createCheckout()).rejects.toThrow(ServiceUnavailableException);
  });

  it('refuses an off-session charge', async () => {
    await expect(provider.chargeSaved()).rejects.toThrow(ServiceUnavailableException);
  });

  /** A 200 with nothing to do is how a webhook endpoint stops a provider retrying. */
  it('has nothing to translate from a webhook', async () => {
    await expect(provider.handleWebhook()).resolves.toEqual([]);
  });
});
