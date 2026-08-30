import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { routerConfig } from '../config.js';
import { Workspace } from '../db/entities/workspace.entity.js';
import { type LedgerEntry, LedgerService } from './ledger.service.js';
import { ManualPaymentProvider } from './manual-payment.provider.js';
import { microsToCents, microsToUsdString } from './money.js';
import { type CheckoutSession, type LedgerEvent, PAYMENT_PROVIDER, type PaymentProvider } from './payment-provider.js';

export interface AutoTopUpSettings {
  enabled: boolean;
  thresholdMicros: number | null;
  amountMicros: number | null;
}

export interface CreditsView {
  workspaceId: string;
  balanceMicros: number;
  spendable: boolean;
  minTopUpMicros: number;
  autoTopUp: AutoTopUpSettings;
  /** False when the provider cannot charge off-session, so the console can say why. */
  autoTopUpAvailable: boolean;
  lastAutoTopUpAt: Date | null;
}

/**
 * Everything the console and the payment provider need from billing, on top of
 * the ledger: checkouts, webhooks, and the auto top-up settings.
 *
 * The split matters — `LedgerService` owns the money invariant and knows nothing
 * about Stripe; this service translates provider events into ledger entries and
 * is the only thing that may write a provider-side customer id onto a workspace.
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  // biome-ignore lint/complexity/useMaxParams: a Nest DI constructor has no call site to keep readable.
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(routerConfig.KEY) private readonly config: ConfigType<typeof routerConfig>,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly ledger: LedgerService,
  ) {}

  get providerName(): string {
    return this.provider.name;
  }

  async creditsView(workspaceId: string): Promise<CreditsView> {
    const workspace = await this.requireWorkspace(workspaceId);
    return {
      workspaceId,
      ...this.ledger.toBalance(workspace.balanceMicros),
      minTopUpMicros: this.config.billing.minTopUpMicros,
      autoTopUp: {
        enabled: workspace.autoTopUpEnabled,
        thresholdMicros: workspace.autoTopUpThresholdMicros,
        amountMicros: workspace.autoTopUpAmountMicros,
      },
      autoTopUpAvailable: this.provider.supportsSavedPaymentMethods,
      lastAutoTopUpAt: workspace.autoTopUpLastAt,
    };
  }

  /** Starts a top-up. The credit only appears once the provider confirms it. */
  async createCheckout(workspaceId: string, amountMicros: number, email: string | null): Promise<CheckoutSession> {
    const workspace = await this.requireWorkspace(workspaceId);
    this.assertTopUpAmount(amountMicros);

    const returnUrl = new URL(this.config.billing.checkoutReturnUrl);
    const successUrl = new URL(returnUrl);
    successUrl.searchParams.set('topup', 'success');
    const cancelUrl = new URL(returnUrl);
    cancelUrl.searchParams.set('topup', 'cancelled');

    const session = await this.provider.createCheckout({
      workspaceId,
      amountMicros,
      customerRef: workspace.stripeCustomerId,
      email,
      successUrl: successUrl.toString(),
      cancelUrl: cancelUrl.toString(),
    });
    this.logger.log(`Checkout ${session.ref} started for workspace ${workspaceId} (${amountMicros} micro-USD).`);
    return session;
  }

  /** Verifies a provider webhook and applies whatever money movements it reports. */
  async handleWebhook(rawBody: Buffer, signature: string | undefined): Promise<LedgerEntry[]> {
    const events = await this.provider.handleWebhook(rawBody, signature);
    return this.apply(events);
  }

  /**
   * The manual provider's stand-in for a webhook: the signed return link is the
   * confirmation. Only reachable when the manual provider is bound.
   */
  async completeManualCheckout(token: string): Promise<{ successUrl: string }> {
    if (!(this.provider instanceof ManualPaymentProvider)) {
      throw new NotFoundException('Not found.');
    }
    const { event, successUrl } = this.provider.completeCheckout(token);
    await this.apply([event]);
    return { successUrl };
  }

  /** Writes provider-confirmed events into the ledger, idempotently. */
  async apply(events: LedgerEvent[]): Promise<LedgerEntry[]> {
    const applied: LedgerEntry[] = [];
    for (const event of events) {
      if (event.customerRef) {
        await this.rememberCustomer(event.workspaceId, event.customerRef);
      }
      const entry = await this.ledger.record({
        workspaceId: event.workspaceId,
        kind: event.kind,
        amountMicros: event.amountMicros,
        reference: event.reference,
        idempotencyKey: event.idempotencyKey,
        description: event.description ?? null,
      });
      if (entry.replayed) {
        this.logger.log(`Ignored a replay of ${event.idempotencyKey}; the ledger already has it.`);
      } else {
        this.logger.log(
          `Recorded ${event.kind} of $${microsToUsdString(event.amountMicros)} for workspace ${event.workspaceId}.`,
        );
      }
      applied.push(entry);
    }
    return applied;
  }

  /** The workspace row billing state hangs off. */
  workspace(workspaceId: string): Promise<Workspace | null> {
    return this.dataSource.getRepository(Workspace).findOne({ where: { id: workspaceId } });
  }

  /**
   * Claims the right to charge this workspace automatically, returning the claim's
   * timestamp or `null` when a recent attempt still holds it.
   *
   * Writing `autoTopUpLastAt` *before* the charge, with the cooldown in the
   * `WHERE` clause, is what makes concurrent debits produce one charge and a
   * declining card back off instead of retrying per request.
   */
  async claimAutoTopUp(workspaceId: string, now: Date): Promise<number | null> {
    const cutoff = now.getTime() - this.config.billing.autoTopUpCooldown;
    const column = this.dataSource.driver.escape('autoTopUpLastAt');
    const claimed = await this.dataSource
      .createQueryBuilder()
      .update(Workspace)
      .set({ autoTopUpLastAt: now })
      .where('id = :workspaceId', { workspaceId })
      .andWhere(`(${column} IS NULL OR ${column} <= :cutoff)`, { cutoff })
      .execute();
    return claimed.affected ? now.getTime() : null;
  }

  async setAutoTopUp(workspaceId: string, settings: AutoTopUpSettings): Promise<CreditsView> {
    await this.requireWorkspace(workspaceId);

    if (settings.enabled) {
      if (settings.thresholdMicros === null || settings.amountMicros === null) {
        throw new BadRequestException('Automatic top-up needs both a threshold and an amount.');
      }
      if (settings.thresholdMicros < 0) {
        throw new BadRequestException('The automatic top-up threshold cannot be negative.');
      }
      this.assertTopUpAmount(settings.amountMicros);
      if (!this.provider.supportsSavedPaymentMethods) {
        throw new BadRequestException(`The ${this.provider.name} payment provider cannot charge a saved card.`);
      }
    }

    await this.dataSource.getRepository(Workspace).update(
      { id: workspaceId },
      {
        autoTopUpEnabled: settings.enabled,
        autoTopUpThresholdMicros: settings.enabled ? settings.thresholdMicros : null,
        autoTopUpAmountMicros: settings.enabled ? settings.amountMicros : null,
      },
    );
    return this.creditsView(workspaceId);
  }

  private assertTopUpAmount(amountMicros: number): void {
    if (amountMicros < this.config.billing.minTopUpMicros) {
      throw new BadRequestException(`The minimum top-up is $${microsToUsdString(this.config.billing.minTopUpMicros)}.`);
    }
    // Throws when the amount is not a whole number of cents, which no provider
    // can charge exactly.
    microsToCents(amountMicros);
  }

  /**
   * Records the provider-side customer the first time we learn it, and never
   * overwrites it: that id is what a saved card hangs off, and replacing it
   * would silently orphan the card the user already gave us.
   */
  private async rememberCustomer(workspaceId: string, customerRef: string): Promise<void> {
    const column = this.dataSource.driver.escape('stripeCustomerId');
    await this.dataSource
      .createQueryBuilder()
      .update(Workspace)
      .set({ stripeCustomerId: customerRef })
      .where('id = :workspaceId', { workspaceId })
      .andWhere(`${column} IS NULL`)
      .execute();
  }

  private async requireWorkspace(workspaceId: string): Promise<Workspace> {
    const workspace = await this.dataSource.getRepository(Workspace).findOne({ where: { id: workspaceId } });
    if (!workspace) {
      throw new NotFoundException('Workspace not found.');
    }
    return workspace;
  }
}
