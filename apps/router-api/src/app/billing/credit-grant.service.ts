import { randomUUID } from 'node:crypto';
import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { routerConfig } from '../config.js';
import { User } from '../db/entities/user.entity.js';
import { Workspace } from '../db/entities/workspace.entity.js';
import { WorkspaceMember } from '../db/entities/workspace-member.entity.js';
import { LedgerService } from './ledger.service.js';
import { microsToUsdString } from './money.js';

/** The two kinds an operator may write. The ledger's other four have non-human origins. */
export type CreditGrantKind = 'grant' | 'adjustment';

export interface CreditGrantRequest {
  /** The workspace to credit. Exactly one of this and `accountEmail`. */
  workspaceId?: string | null;
  /** The account holder to credit, resolved to the workspace they own. */
  accountEmail?: string | null;
  kind: CreditGrantKind;
  /** Signed micro-USD. Negative is a debit and only `adjustment` may carry one. */
  amountMicros: number;
  /** Why. Mandatory on a debit; the ledger keeps it verbatim. */
  note?: string | null;
  operator: { id: string; email: string };
}

export interface CreditGrantResult {
  creditTransactionId: string;
  workspaceId: string;
  /** The account the workspace was reached through, when it was reached through one. */
  accountEmail: string | null;
  kind: CreditGrantKind;
  amountMicros: number;
  /** The workspace balance after the entry. */
  balanceMicros: number;
  note: string | null;
  createdAt: Date;
}

/**
 * `reference` on the ledger entry an operator grant writes.
 *
 * The Credits screen reads `reference` to name a row's origin — `signup` for the
 * registration grant, the campaign for an invitation one — and an operator grant
 * needs its own answer there rather than borrowing a campaign it has nothing to
 * do with (SUP-406).
 */
export const OPERATOR_GRANT_REFERENCE = 'operator';

/**
 * Putting credit on an account that already exists (SUP-406).
 *
 * Before this, credit could only enter a balance two ways: a checkout the user
 * paid for, or an invitation code redeemed *at sign-up*. Topping up a tester who
 * had already signed up was impossible without a product change, and the
 * requests that need it are ordinary — a burnt-through grant, goodwill after an
 * incident, a refund that is not a Stripe refund (SUP-389).
 *
 * Nothing about the ledger changes for it: this writes one `grant` (or
 * `adjustment`) entry through {@link LedgerService.record}, exactly as the
 * invitation and sign-up grants do, so invariant 3 — the cached balance is the
 * sum of the ledger — holds by the same construction. What this class adds is
 * the three things a hand-written entry needs and an automatic one does not:
 *
 *  - **A named operator on the row.** `grantedByUserId`, so the ledger answers
 *    "who granted this" without a log search. The caller is already known to be
 *    in `auth.adminEmails` — `AdminGuard` is on the resolver — and the audit line
 *    names them too, but a log rotates and the ledger does not.
 *  - **A ceiling.** `billing.maxCreditGrantMicros` bounds the magnitude of one
 *    call the way `maxTopUpMicros` bounds one checkout: what this accepts is
 *    what a single fat finger, or a single stolen operator session, can do.
 *  - **A separate guard on taking credit away.** A negative amount has to be an
 *    `adjustment`, needs `billing.allowCreditDebits` to be on, and must carry a
 *    note. On top of that the ledger refuses to overdraw an `adjustment`, so no
 *    sequence of calls here can push a balance below zero.
 */
@Injectable()
export class CreditGrantService {
  private readonly logger = new Logger(CreditGrantService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(routerConfig.KEY) private readonly config: ConfigType<typeof routerConfig>,
    private readonly ledger: LedgerService,
  ) {}

  async grant(request: CreditGrantRequest): Promise<CreditGrantResult> {
    const amountMicros = this.assertAmount(request);
    const note = request.note?.trim() ? request.note.trim() : null;
    if (amountMicros < 0 && !note) {
      throw new BadRequestException('A debit needs a note saying why the credit is being taken away.');
    }

    const target = await this.resolveTarget(request);

    const entry = await this.ledger.record({
      workspaceId: target.workspaceId,
      kind: request.kind,
      amountMicros,
      reference: OPERATOR_GRANT_REFERENCE,
      // What the account holder reads on their Credits screen. The note is
      // theirs to see — an operator writing "goodwill after the 14 Oct outage"
      // is saying it to them — and the operator's own address is deliberately
      // not in here: it belongs on `grantedByUserId`, where a rewrite of this
      // text cannot lose it.
      description: note
        ? `${this.label(request.kind, amountMicros)} · ${note}`
        : this.label(request.kind, amountMicros),
      grantedByUserId: request.operator.id,
      // A deliberate operator action, repeated deliberately, is a second entry —
      // unlike a redelivered webhook, there is no outside event two calls could
      // be two reports of. So the key is fresh per call, and the console's own
      // dialog is what stops a double-click from becoming a double grant.
      idempotencyKey: `operator:${randomUUID()}`,
    });

    this.logger.warn(
      `Credit ${amountMicros < 0 ? 'removed' : 'granted'} by ${request.operator.email} — ` +
        `${microsToUsdString(amountMicros)} USD as a ${request.kind} on workspace ${target.workspaceId}` +
        `${target.accountEmail ? ` (${target.accountEmail})` : ''}, ` +
        `balance now ${microsToUsdString(entry.balanceMicros)} USD${note ? `: ${note}` : ''}.`,
    );

    return {
      creditTransactionId: entry.transaction.id,
      workspaceId: target.workspaceId,
      accountEmail: target.accountEmail,
      kind: request.kind,
      amountMicros,
      balanceMicros: entry.balanceMicros,
      note,
      createdAt: entry.transaction.createdAt,
    };
  }

  /**
   * The bounds that are this class's own, before the ledger's.
   *
   * `LedgerService.assertSign` would already refuse a negative `grant` and a
   * zero of any kind, but it answers with `LedgerSignError` — a statement about
   * the ledger's kinds, not about what an operator is allowed to ask for. The
   * caller here is a human reading an error message in a dialog.
   */
  private assertAmount(request: CreditGrantRequest): number {
    const { amountMicros, kind } = request;
    const ceiling = this.config.billing.maxCreditGrantMicros;

    if (!Number.isSafeInteger(amountMicros) || amountMicros === 0) {
      throw new BadRequestException('The amount must be a whole number of micro-USD and cannot be zero.');
    }
    if (Math.abs(amountMicros) > ceiling) {
      throw new BadRequestException(
        `One grant is limited to $${microsToUsdString(ceiling)} (billing.maxCreditGrantMicros); ` +
          `$${microsToUsdString(Math.abs(amountMicros))} was asked for.`,
      );
    }
    if (amountMicros < 0) {
      if (kind !== 'adjustment') {
        throw new BadRequestException('Removing credit is an ADJUSTMENT, not a GRANT.');
      }
      if (!this.config.billing.allowCreditDebits) {
        throw new BadRequestException(
          'This deployment does not allow credit to be removed. Set billing.allowCreditDebits to enable it.',
        );
      }
    }
    return amountMicros;
  }

  /**
   * The workspace to credit, from either a workspace id or an account address.
   *
   * The console sends the id it already has on screen; the address is for an
   * operator working from a support thread, which is where this operation gets
   * reached for in the first place. An unknown account is a plain `404` with the
   * address in it: the caller is an operator who mistyped, and there is no
   * existence to protect from somebody who can already list every account.
   */
  private async resolveTarget(
    request: CreditGrantRequest,
  ): Promise<{ workspaceId: string; accountEmail: string | null }> {
    const email = request.accountEmail?.trim() ? request.accountEmail.trim() : null;
    const workspaceId = request.workspaceId?.trim() ? request.workspaceId.trim() : null;

    if (Boolean(email) === Boolean(workspaceId)) {
      throw new BadRequestException('Name the account to credit by either accountEmail or workspaceId, not both.');
    }

    if (workspaceId) {
      const workspace = await this.dataSource
        .getRepository(Workspace)
        .findOne({ where: { id: workspaceId }, select: { id: true } });
      if (!workspace) {
        throw new NotFoundException(`No workspace ${workspaceId}.`);
      }
      return { workspaceId, accountEmail: null };
    }

    const account = await this.accountOf(email as string);
    if (!account) {
      throw new NotFoundException(`No account for ${email}.`);
    }
    // The oldest workspace they own, which is the one the console opens on and
    // the only one a personal account has (`WorkspaceScopeService.defaultForUser`).
    const membership = await this.dataSource.getRepository(WorkspaceMember).findOne({
      where: { userId: account.id, role: 'owner' },
      order: { createdAt: 'ASC' },
      select: { workspaceId: true, userId: true },
    });
    if (!membership) {
      throw new NotFoundException(`${account.email} owns no workspace, so there is no balance to credit.`);
    }
    return { workspaceId: membership.workspaceId, accountEmail: account.email };
  }

  /**
   * The account behind an address, matched without regard to case.
   *
   * Better Auth stores what the person typed and neither database has a
   * case-insensitive type both of them share (`data-model.md`), so the
   * comparison is lowered on both sides rather than relying on an index hit.
   */
  private async accountOf(email: string): Promise<User | null> {
    return this.dataSource
      .getRepository(User)
      .createQueryBuilder('account')
      .where('LOWER(account.email) = :email', { email: email.toLowerCase() })
      .orderBy('account.createdAt', 'ASC')
      .getOne();
  }

  /** The leading half of the row's description — what kind of movement this was. */
  private label(kind: CreditGrantKind, amountMicros: number): string {
    if (kind === 'grant') {
      return 'Credit granted by an operator';
    }
    return amountMicros < 0 ? 'Credit removed by an operator' : 'Credit adjusted by an operator';
  }
}
