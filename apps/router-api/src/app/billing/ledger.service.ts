import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager, QueryFailedError } from 'typeorm';
import { type Cursor, decodeCursor, encodeCursor } from '../common/cursor.js';
import { routerConfig } from '../config.js';
import { CreditTransaction, type CreditTransactionKind } from '../db/entities/credit-transaction.entity.js';
import { Workspace } from '../db/entities/workspace.entity.js';
import { InsufficientCreditsError, LedgerSignError } from './ledger.errors.js';

export interface LedgerEntryInput {
  workspaceId: string;
  kind: CreditTransactionKind;
  /** Signed micro-USD: credits are positive, anything that removes credit is negative. */
  amountMicros: number;
  /** Unique per real-world event. A replay of the same event collapses onto the first row. */
  idempotencyKey: string;
  reference?: string | null;
  description?: string | null;
}

export interface LedgerEntry {
  transaction: CreditTransaction;
  /** The workspace balance after the entry — or the unchanged one, on a replay. */
  balanceMicros: number;
  /** True when this exact `idempotencyKey` had already been recorded and nothing was written. */
  replayed: boolean;
}

export interface LedgerPageQuery {
  workspaceId: string;
  first?: number | null;
  after?: string | null;
}

export interface LedgerPage {
  edges: Array<{ cursor: string; node: CreditTransaction }>;
  hasNextPage: boolean;
  endCursor: string | null;
  totalCount: number;
}

export interface CreditsBalance {
  balanceMicros: number;
  /** False once the workspace is out of credit; `/v1` answers `402 insufficient_credits`. */
  spendable: boolean;
}

/**
 * Which kinds may carry which sign. `adjustment` is the operator's escape hatch
 * and is the only one allowed either way.
 */
const REQUIRED_SIGN: Record<CreditTransactionKind, 'positive' | 'negative' | 'any'> = {
  purchase: 'positive',
  auto_topup: 'positive',
  usage: 'negative',
  refund: 'negative',
  adjustment: 'any',
};

/** The one serialisation key SQLite gets, because it has one writer. */
const SQLITE_WRITER = '__sqlite__';

function ignore(): void {
  // The chain only orders writes; each caller handles its own failure.
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 200;

/** Kinds whose amount is not known before the money is spent, so they may overdraw. */
const MAY_OVERDRAW: ReadonlySet<CreditTransactionKind> = new Set<CreditTransactionKind>(['usage']);

/**
 * The credits ledger: the single writer of `credit_transactions`, and the only
 * code allowed to move `workspaces.balanceMicros`.
 *
 * Two properties are load-bearing and both are structural rather than
 * conventional (`docs/contracts/data-model.md` invariant 3):
 *
 *  - **The cache never diverges from the ledger.** Every write happens in one
 *    database transaction that updates the balance with a *relative* statement
 *    (`balanceMicros = balanceMicros + :delta`) and inserts the matching row. No
 *    read-modify-write means no lost update, and no `SELECT … FOR UPDATE` means
 *    the same code is correct on SQLite, which has neither row locks nor the
 *    syntax for them.
 *  - **A repeated event cannot charge twice.** The unique index on
 *    `idempotencyKey` is what enforces it — a redelivered Stripe webhook or a
 *    retried debit loses the insert race, the whole transaction rolls back, and
 *    the caller gets the row that already existed.
 *
 * There is deliberately no update or delete path here: a correction is a new
 * `adjustment` row. `ledger-invariants.spec.ts` fails the build if one appears.
 */
@Injectable()
export class LedgerService {
  private readonly logger = new Logger(LedgerService.name);

  /** Tail of the in-flight write chain, per serialisation key. */
  private readonly queue = new Map<string, Promise<void>>();

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(routerConfig.KEY) private readonly config: ConfigType<typeof routerConfig>,
  ) {}

  async balanceOf(workspaceId: string): Promise<CreditsBalance> {
    const workspace = await this.dataSource
      .getRepository(Workspace)
      .findOne({ where: { id: workspaceId }, select: { id: true, balanceMicros: true } });
    if (!workspace) {
      throw new NotFoundException('Workspace not found.');
    }
    return this.toBalance(workspace.balanceMicros);
  }

  toBalance(balanceMicros: number): CreditsBalance {
    return { balanceMicros, spendable: balanceMicros + this.config.billing.allowOverdraftMicros > 0 };
  }

  /**
   * Appends one entry and moves the balance with it, or returns the entry that
   * this `idempotencyKey` already produced.
   */
  async record(input: LedgerEntryInput): Promise<LedgerEntry> {
    this.assertSign(input);

    const existing = await this.findByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      return this.replay(existing);
    }

    try {
      return await this.serialize(input.workspaceId, () =>
        this.dataSource.transaction((manager) => this.append(manager, input)),
      );
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      // Lost the race against a concurrent write of the same event. That is the
      // idempotency guarantee working, not a failure: the other writer's row is
      // the answer.
      const winner = await this.findByIdempotencyKey(input.idempotencyKey);
      if (!winner) {
        throw error;
      }
      return this.replay(winner);
    }
  }

  /**
   * The usage debit for one generation, keyed on the generation id so a retried
   * metering write cannot charge the same request twice. A free generation
   * (zero cost) writes nothing — an empty ledger row would only be noise.
   */
  async debitGeneration(input: {
    workspaceId: string;
    generationId: string;
    amountMicros: number;
  }): Promise<LedgerEntry | null> {
    if (input.amountMicros <= 0) {
      return null;
    }
    return this.record({
      workspaceId: input.workspaceId,
      kind: 'usage',
      amountMicros: -input.amountMicros,
      reference: input.generationId,
      idempotencyKey: `generation:${input.generationId}`,
      description: null,
    });
  }

  /**
   * The Credits screen's ledger list, newest first.
   *
   * Keyset-paginated on `(createdAt, id)`: the ledger only ever grows, so an
   * offset page would shift under the reader every time a generation is metered.
   */
  async page(query: LedgerPageQuery): Promise<LedgerPage> {
    const size = Math.min(Math.max(query.first ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const repository = this.dataSource.getRepository(CreditTransaction);

    const totalCount = await repository.count({ where: { workspaceId: query.workspaceId } });
    const builder = repository
      .createQueryBuilder('entry')
      .where('entry.workspaceId = :workspaceId', { workspaceId: query.workspaceId });
    if (query.after) {
      const cursor: Cursor = decodeCursor(query.after);
      builder.andWhere(
        '(entry.createdAt < :cursorValue OR (entry.createdAt = :cursorValue AND entry.id < :cursorId))',
        { cursorValue: cursor.value, cursorId: cursor.id },
      );
    }
    const rows = await builder
      .orderBy('entry.createdAt', 'DESC')
      .addOrderBy('entry.id', 'DESC')
      // One more than asked for, so `hasNextPage` costs a row rather than a query.
      .take(size + 1)
      .getMany();

    const hasNextPage = rows.length > size;
    const page = hasNextPage ? rows.slice(0, size) : rows;
    const edges = page.map((node) => ({
      cursor: encodeCursor({ value: node.createdAt.getTime(), id: node.id }),
      node,
    }));
    return { edges, hasNextPage, endCursor: edges.at(-1)?.cursor ?? null, totalCount };
  }

  /**
   * Runs one ledger transaction at a time per key.
   *
   * PostgreSQL does not need this for correctness — the relative `UPDATE` is
   * atomic and its row lock orders concurrent writers — but SQLite has a single
   * connection and no nested transactions, so two overlapping writes there fail
   * outright rather than serialising. Queueing keeps development and the test
   * suite behaving like production instead of like a different database.
   */
  private serialize<T>(workspaceId: string, task: () => Promise<T>): Promise<T> {
    // On SQLite the writer is the database, not the row: one queue for everything.
    const key = this.dataSource.options.type.includes('sqlite') ? SQLITE_WRITER : workspaceId;
    const previous = this.queue.get(key) ?? Promise.resolve();
    const result = previous.then(task, task);
    const settled = result.then(ignore, ignore);
    this.queue.set(key, settled);
    void settled.then(() => {
      // Only the last writer clears the slot, so the map cannot grow without bound.
      if (this.queue.get(key) === settled) {
        this.queue.delete(key);
      }
    });
    return result;
  }

  private async append(manager: EntityManager, input: LedgerEntryInput): Promise<LedgerEntry> {
    const balanceColumn = manager.connection.driver.escape('balanceMicros');
    const allowOverdraw = MAY_OVERDRAW.has(input.kind);

    const update = manager
      .createQueryBuilder()
      .update(Workspace)
      .set({ balanceMicros: () => `${balanceColumn} + :delta` })
      .where('id = :workspaceId', { workspaceId: input.workspaceId })
      .setParameter('delta', input.amountMicros);
    if (!allowOverdraw && input.amountMicros < 0) {
      update.andWhere(`${balanceColumn} + :delta >= 0`);
    }
    const updated = await update.execute();

    if (!updated.affected) {
      const workspace = await manager.findOne(Workspace, {
        where: { id: input.workspaceId },
        select: { id: true, balanceMicros: true },
      });
      if (!workspace) {
        throw new NotFoundException('Workspace not found.');
      }
      throw new InsufficientCreditsError(workspace.balanceMicros, input.amountMicros);
    }

    const values = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      kind: input.kind,
      amountMicros: input.amountMicros,
      reference: input.reference ?? null,
      description: input.description ?? null,
      idempotencyKey: input.idempotencyKey,
      createdAt: new Date(),
    };
    await manager.insert(CreditTransaction, values);
    const transaction = manager.create(CreditTransaction, values);

    const workspace = await manager.findOne(Workspace, {
      where: { id: input.workspaceId },
      select: { id: true, balanceMicros: true },
    });
    const balanceMicros = workspace?.balanceMicros ?? 0;

    if (balanceMicros < 0) {
      this.logger.warn(`Workspace ${input.workspaceId} is overdrawn: ${balanceMicros} micro-USD.`);
    }
    return { transaction, balanceMicros, replayed: false };
  }

  private assertSign(input: LedgerEntryInput): void {
    const required = REQUIRED_SIGN[input.kind];
    const wrong =
      input.amountMicros === 0 ||
      (required === 'positive' && input.amountMicros < 0) ||
      (required === 'negative' && input.amountMicros > 0);
    if (wrong) {
      throw new LedgerSignError(input.kind, input.amountMicros);
    }
  }

  private findByIdempotencyKey(idempotencyKey: string): Promise<CreditTransaction | null> {
    return this.dataSource.getRepository(CreditTransaction).findOne({ where: { idempotencyKey } });
  }

  private async replay(transaction: CreditTransaction): Promise<LedgerEntry> {
    const workspace = await this.dataSource.getRepository(Workspace).findOne({
      where: { id: transaction.workspaceId },
      select: { id: true, balanceMicros: true },
    });
    return { transaction, balanceMicros: workspace?.balanceMicros ?? 0, replayed: true };
  }
}

/**
 * A unique-index violation, on either driver. PostgreSQL reports SQLSTATE
 * `23505`; better-sqlite3 has no code worth matching and only says so in the
 * message.
 */
export function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) {
    return false;
  }
  const driverError = error.driverError as { code?: string } | undefined;
  return driverError?.code === '23505' || /UNIQUE constraint failed/i.test(error.message);
}
