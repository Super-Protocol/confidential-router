import { UseGuards } from '@nestjs/common';
import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { CurrentUser, SessionGuard, type SessionUser, WorkspaceScopeService } from '../../../auth/index.js';
import { BillingService, type CreditsView, LedgerService, parseMicros } from '../../../billing/index.js';
import type { CreditTransaction, CreditTransactionKind } from '../../../db/entities/credit-transaction.entity.js';
import { CreateCheckoutInput, SetAutoTopUpInput } from './credits.input.js';
import {
  CheckoutSessionModel,
  CreditBalanceModel,
  CreditTransactionConnectionModel,
  CreditTransactionKindEnum,
  type CreditTransactionModel,
  CreditTransactionsArgs,
} from './credits.model.js';

/**
 * The Credits screen.
 *
 * Top-ups and auto top-up settings move money, so they require the `owner` role
 * — a member may read the ledger their generations wrote to, and may not spend
 * the workspace's card.
 */
@Resolver()
@UseGuards(SessionGuard)
export class CreditsResolver {
  constructor(
    private readonly billing: BillingService,
    private readonly ledger: LedgerService,
    private readonly workspaces: WorkspaceScopeService,
  ) {}

  @Query(() => CreditBalanceModel, { description: 'Balance, admission state and automatic top-up settings.' })
  async creditBalance(
    @CurrentUser() user: SessionUser,
    @Args('workspaceId', { type: () => ID }) workspaceId: string,
  ): Promise<CreditBalanceModel> {
    await this.workspaces.requireMembership(user.id, workspaceId);
    return balanceModel(await this.billing.creditsView(workspaceId));
  }

  @Query(() => CreditTransactionConnectionModel, { description: 'The credits ledger, newest first.' })
  async creditTransactions(
    @CurrentUser() user: SessionUser,
    @Args() args: CreditTransactionsArgs,
  ): Promise<CreditTransactionConnectionModel> {
    await this.workspaces.requireMembership(user.id, args.workspaceId);
    const page = await this.ledger.page({
      workspaceId: args.workspaceId,
      first: args.first,
      after: args.after ?? null,
    });
    return {
      edges: page.edges.map((edge) => ({ cursor: edge.cursor, node: transactionModel(edge.node) })),
      pageInfo: { hasNextPage: page.hasNextPage, endCursor: page.endCursor },
      totalCount: page.totalCount,
    };
  }

  @Mutation(() => CheckoutSessionModel, { description: 'Starts a top-up. Credit appears once the provider confirms.' })
  async createCheckout(
    @CurrentUser() user: SessionUser,
    @Args('input') input: CreateCheckoutInput,
  ): Promise<CheckoutSessionModel> {
    await this.workspaces.requireMembership(user.id, input.workspaceId, 'owner');
    return this.billing.createCheckout(input.workspaceId, parseMicros(input.amountMicros, 'amountMicros'), user.email);
  }

  @Mutation(() => CreditBalanceModel, { description: 'Turns automatic top-up on or off.' })
  async setAutoTopUp(
    @CurrentUser() user: SessionUser,
    @Args('input') input: SetAutoTopUpInput,
  ): Promise<CreditBalanceModel> {
    await this.workspaces.requireMembership(user.id, input.workspaceId, 'owner');
    const view = await this.billing.setAutoTopUp(input.workspaceId, {
      enabled: input.settings.enabled,
      thresholdMicros: input.settings.thresholdMicros
        ? parseMicros(input.settings.thresholdMicros, 'thresholdMicros')
        : null,
      amountMicros: input.settings.amountMicros ? parseMicros(input.settings.amountMicros, 'amountMicros') : null,
    });
    return balanceModel(view);
  }
}

const KINDS: Record<CreditTransactionKind, CreditTransactionKindEnum> = {
  purchase: CreditTransactionKindEnum.PURCHASE,
  usage: CreditTransactionKindEnum.USAGE,
  refund: CreditTransactionKindEnum.REFUND,
  adjustment: CreditTransactionKindEnum.ADJUSTMENT,
  auto_topup: CreditTransactionKindEnum.AUTO_TOPUP,
};

function transactionModel(entry: CreditTransaction): CreditTransactionModel {
  return {
    id: entry.id,
    createdAt: entry.createdAt,
    kind: KINDS[entry.kind],
    amountMicros: String(entry.amountMicros),
    reference: entry.reference,
    description: entry.description,
  };
}

function balanceModel(view: CreditsView): CreditBalanceModel {
  return {
    workspaceId: view.workspaceId,
    balanceMicros: String(view.balanceMicros),
    spendable: view.spendable,
    minTopUpMicros: String(view.minTopUpMicros),
    autoTopUp: {
      enabled: view.autoTopUp.enabled,
      thresholdMicros: view.autoTopUp.thresholdMicros === null ? null : String(view.autoTopUp.thresholdMicros),
      amountMicros: view.autoTopUp.amountMicros === null ? null : String(view.autoTopUp.amountMicros),
      lastChargedAt: view.lastAutoTopUpAt,
      available: view.autoTopUpAvailable,
    },
  };
}
