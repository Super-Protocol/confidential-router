import { Logger, Module } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { routerConfig } from '../config.js';
import { CreditTransaction } from '../db/entities/credit-transaction.entity.js';
import { Workspace } from '../db/entities/workspace.entity.js';
import { AutoTopUpService } from './auto-top-up.service.js';
import { BillingController } from './billing.controller.js';
import { BillingService } from './billing.service.js';
import { LedgerCreditsGateway } from './credits.gateway.js';
import { LedgerService } from './ledger.service.js';
import { ManualPaymentProvider } from './manual-payment.provider.js';
import { PAYMENT_PROVIDER, type PaymentProvider } from './payment-provider.js';
import { StripePaymentProvider } from './stripe-payment.provider.js';

export class ManualProviderInProductionError extends Error {
  constructor() {
    super(
      'billing.stripe is not configured. The manual payment provider mints credit from a signed link and ' +
        'must never run in production — set billing.stripe.secretKey and billing.stripe.webhookSecret.',
    );
    this.name = 'ManualProviderInProductionError';
  }
}

/**
 * Picks the payment provider from configuration: Stripe when it is configured,
 * the manual one otherwise (ADR-005 §4).
 *
 * Falling back rather than failing is what lets `nx serve` and the e2e suite run
 * a complete top-up without Stripe credentials. Production is the case where the
 * fallback would be a way to create money out of nothing, so there it is fatal.
 */
export function createPaymentProvider(
  config: ConfigType<typeof routerConfig>,
  env: NodeJS.ProcessEnv = process.env,
): PaymentProvider {
  if (config.billing.stripe) {
    return new StripePaymentProvider(config);
  }
  if (env.NODE_ENV === 'production') {
    throw new ManualProviderInProductionError();
  }
  new Logger('BillingModule').warn(
    'billing.stripe is not configured; using the manual payment provider. Top-ups are signed links, not payments.',
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
