import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { routerConfig } from '../config.js';
import { Workspace } from '../db/entities/workspace.entity.js';

/** Injection token for the credits implementation the gateway talks to. */
export const CREDITS_GATEWAY = Symbol('CREDITS_GATEWAY');

export interface CreditsBalance {
  /** False once the workspace is out of credit; the gateway answers 402. */
  spendable: boolean;
  balanceMicros: number;
}

export interface CreditsDebit {
  workspaceId: string;
  generationId: string;
  amountMicros: number;
}

/**
 * What `/v1` needs from billing: may this workspace spend, and here is what it
 * spent.
 *
 * An interface rather than a direct dependency on the ledger, because the
 * append-only `credit_transactions` writer is SUP-75's; the gateway is finished
 * without it and gets the real accounting the moment that provider replaces
 * `WorkspaceBalanceCreditsGateway` under this token.
 */
export interface CreditsGateway {
  balanceOf(workspaceId: string): Promise<CreditsBalance>;
  debit(input: CreditsDebit): Promise<void>;
}

/**
 * Reads `workspaces.balanceMicros` and stops there.
 *
 * `debit` is deliberately a no-op: `balanceMicros` must equal the sum of the
 * ledger after every write (`data-model.md` invariant 3), so decrementing it
 * without the matching `CreditTransaction` would break the invariant SUP-75
 * enforces. Until the ledger lands, what a generation cost is recorded on the
 * `Generation` row and on `ApiKey.spentTotalMicros`, both of which this app
 * owns outright.
 */
@Injectable()
export class WorkspaceBalanceCreditsGateway implements CreditsGateway {
  private readonly logger = new Logger(WorkspaceBalanceCreditsGateway.name);

  constructor(
    @Inject(routerConfig.KEY) private readonly config: ConfigType<typeof routerConfig>,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async balanceOf(workspaceId: string): Promise<CreditsBalance> {
    const workspace = await this.dataSource
      .getRepository(Workspace)
      .findOne({ where: { id: workspaceId }, select: { id: true, balanceMicros: true } });
    const balanceMicros = workspace?.balanceMicros ?? 0;
    return { spendable: balanceMicros + this.config.billing.allowOverdraftMicros > 0, balanceMicros };
  }

  async debit(input: CreditsDebit): Promise<void> {
    this.logger.debug(
      `Generation ${input.generationId} cost ${input.amountMicros} micros; ledger write is pending SUP-75.`,
    );
  }
}
