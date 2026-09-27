import { describe, expect, it } from 'vitest';
import { testConfig } from '../../../test/seed.js';
import {
  createPaymentProvider,
  ManualProviderInProductionError,
  ManualProviderOnPublicDeploymentError,
  StripeProviderNotConfiguredError,
} from './billing.module.js';

const STRIPE = {
  CR_API_BILLING__STRIPE__SECRET_KEY: 'sk_test_00000000000000000000000000',
  CR_API_BILLING__STRIPE__WEBHOOK_SECRET: 'whsec_test',
};

/** What a deployment looks like: a hostname other people can reach. */
const PUBLIC = { CR_API_SERVER__PUBLIC_BASE_URL: 'https://api.router.superprotocol.com' };

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

  /**
   * The SUP-167 regression. The deployment that shipped this bug had exactly this
   * shape: a public hostname and `NODE_ENV: development` from the chart, which
   * walked straight past the production check and bound a provider that mints.
   */
  it('refuses the manual provider on a public publicBaseUrl even outside production', () => {
    expect(() => createPaymentProvider(testConfig(PUBLIC), { NODE_ENV: 'development' })).toThrow(
      ManualProviderOnPublicDeploymentError,
    );
  });

  it('names the offending URL, so the refusal says what to change', () => {
    expect(() => createPaymentProvider(testConfig(PUBLIC), { NODE_ENV: 'development' })).toThrow(
      /https:\/\/api\.router\.superprotocol\.com/,
    );
  });

  it('still binds the manual provider on a loopback address that is not "localhost"', () => {
    const config = testConfig({ CR_API_SERVER__PUBLIC_BASE_URL: 'http://127.0.0.1:3000' });
    expect(createPaymentProvider(config, { NODE_ENV: 'development' }).name).toBe('manual');
  });

  it('uses Stripe on a public deployment, which is the point of configuring it', () => {
    expect(createPaymentProvider(testConfig({ ...STRIPE, ...PUBLIC }), { NODE_ENV: 'production' }).name).toBe('stripe');
  });

  describe('billing.provider', () => {
    it('binds the disabled provider, so a deployment that sells nothing boots', () => {
      const config = testConfig({ ...PUBLIC, CR_API_BILLING__PROVIDER: 'disabled' });
      const provider = createPaymentProvider(config, { NODE_ENV: 'production' });

      expect(provider.name).toBe('disabled');
      expect(provider.supportsCheckout).toBe(false);
    });

    it('refuses "stripe" without credentials rather than falling back to one that mints', () => {
      expect(() => createPaymentProvider(testConfig({ CR_API_BILLING__PROVIDER: 'stripe' }))).toThrow(
        StripeProviderNotConfiguredError,
      );
    });

    it('holds an explicit "manual" to the same two conditions as the fallback', () => {
      const config = testConfig({ ...PUBLIC, CR_API_BILLING__PROVIDER: 'manual' });
      expect(() => createPaymentProvider(config, { NODE_ENV: 'development' })).toThrow(
        ManualProviderOnPublicDeploymentError,
      );
    });
  });
});
