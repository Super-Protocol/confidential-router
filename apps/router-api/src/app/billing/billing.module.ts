import { Logger, Module } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { isLoopbackUrl } from '../common/loopback.js';
import { routerConfig } from '../config.js';
import { CreditTransaction } from '../db/entities/credit-transaction.entity.js';
import { Workspace } from '../db/entities/workspace.entity.js';
import { AutoTopUpService } from './auto-top-up.service.js';
import { BillingController } from './billing.controller.js';
import { BillingService } from './billing.service.js';
import { LedgerCreditsGateway } from './credits.gateway.js';
import { DisabledPaymentProvider } from './disabled-payment.provider.js';
import { LedgerService } from './ledger.service.js';
import { ManualPaymentProvider } from './manual-payment.provider.js';
import { PAYMENT_PROVIDER, type PaymentProvider } from './payment-provider.js';
import { StripePaymentProvider } from './stripe-payment.provider.js';

export class ManualProviderInProductionError extends Error {
  constructor() {
    super(
      'The manual payment provider mints credit from a signed link and must never run in production. ' +
        'Set billing.stripe.secretKey and billing.stripe.webhookSecret to take payments, or ' +
        'billing.provider: disabled to switch buying off.',
    );
    this.name = 'ManualProviderInProductionError';
  }
}

export class ManualProviderOnPublicDeploymentError extends Error {
  constructor(publicBaseUrl: string) {
    super(
      `The manual payment provider mints credit from a signed link and server.publicBaseUrl is ${publicBaseUrl}, ` +
        'which is not a loopback address: every account that can sign in could give itself credit. ' +
        'Set billing.stripe.secretKey and billing.stripe.webhookSecret to take payments, or ' +
        'billing.provider: disabled to switch buying off.',
    );
    this.name = 'ManualProviderOnPublicDeploymentError';
  }
}

export class StripeProviderNotConfiguredError extends Error {
  constructor() {
    super(
      'billing.provider is "stripe" but billing.stripe is not configured — ' +
        'set billing.stripe.secretKey and billing.stripe.webhookSecret.',
    );
    this.name = 'StripeProviderNotConfiguredError';
  }
}

/**
 * Picks the payment provider from configuration (ADR-005 §4).
 *
 * `billing.provider: auto` keeps the rule this module was written with — Stripe
 * when it is configured, the manual provider otherwise — because that fallback is
 * what lets `nx serve` and the e2e suite run a complete top-up without Stripe
 * credentials.
 *
 * What changed in SUP-167 is where the fallback is allowed. The manual provider
 * mints credit from a signed link, so binding it on a deployment anyone else can
 * reach is a way to create money out of nothing; `NODE_ENV` was the only thing
 * standing between those two cases, and a deployment chart sets `NODE_ENV`. Two
 * independent conditions now have to hold — not production, *and* a
 * `server.publicBaseUrl` only this machine can reach — and neither of them is an
 * environment variable a chart can quietly overwrite. A deployment that wants no
 * purchases says so with `billing.provider: disabled` instead of arriving there
 * by omission.
 */
export function createPaymentProvider(
  config: ConfigType<typeof routerConfig>,
  env: NodeJS.ProcessEnv = process.env,
): PaymentProvider {
  const chosen = config.billing.provider;

  if (chosen === 'disabled') {
    return new DisabledPaymentProvider();
  }
  if (chosen === 'stripe') {
    if (!config.billing.stripe) {
      throw new StripeProviderNotConfiguredError();
    }
    return new StripePaymentProvider(config);
  }
  if (chosen === 'auto' && config.billing.stripe) {
    return new StripePaymentProvider(config);
  }

  if (env.NODE_ENV === 'production') {
    throw new ManualProviderInProductionError();
  }
  if (!isLoopbackUrl(config.server.publicBaseUrl)) {
    throw new ManualProviderOnPublicDeploymentError(config.server.publicBaseUrl);
  }
  new Logger('BillingModule').warn(
    `Binding the manual payment provider: top-ups on ${config.server.publicBaseUrl} are signed links, not payments.`,
  );
  return new ManualPaymentProvider(config);
}

@Module({
  imports: [TypeOrmModule.forFeature([Workspace, CreditTransaction])],
  controllers: [BillingController],
  providers: [
    {
      provide: PAYMENT_PROVIDER,
      inject: [routerConfig.KEY],
      useFactory: (config: ConfigType<typeof routerConfig>) => createPaymentProvider(config),
    },
    LedgerService,
    BillingService,
    AutoTopUpService,
    LedgerCreditsGateway,
  ],
  exports: [LedgerService, BillingService, AutoTopUpService, LedgerCreditsGateway, PAYMENT_PROVIDER],
})
export class BillingModule {}
