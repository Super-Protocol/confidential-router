import { describe, expect, it } from 'vitest';
import { testConfig } from '../../../test/seed.js';
import { createPaymentProvider, ManualProviderInProductionError } from './billing.module.js';

const STRIPE = {
  CR_API_BILLING__STRIPE__SECRET_KEY: 'sk_test_00000000000000000000000000',
  CR_API_BILLING__STRIPE__WEBHOOK_SECRET: 'whsec_test',
};

describe('choosing the payment provider', () => {
  it('uses Stripe when it is configured', () => {
    expect(createPaymentProvider(testConfig(STRIPE)).name).toBe('stripe');
  });

  it('falls back to the manual provider in development, so a laptop can top up', () => {
    expect(createPaymentProvider(testConfig(), { NODE_ENV: 'development' }).name).toBe('manual');
  });

  it('refuses to boot production on the manual provider', () => {
    // It mints credit from a signed link; running it against real customers
    // would be a way to create money out of nothing.
    expect(() => createPaymentProvider(testConfig(), { NODE_ENV: 'production' })).toThrow(
      ManualProviderInProductionError,
    );
  });

  it('uses Stripe in production, as configured', () => {
    expect(createPaymentProvider(testConfig(STRIPE), { NODE_ENV: 'production' }).name).toBe('stripe');
  });
});
