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
  /** Why. Mandatory, whichever direction the credit moves; the ledger keeps it verbatim. */
  note: string;
  /**
   * The caller's name for this decision, unique per decision and stable across
   * its retries. One submission sent twice carries the same one and writes one
   * row; a second deliberate grant carries a new one (SUP-398).
   */
  requestId: string;
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
  note: string;
  createdAt: Date;
  /**
   * True when this `requestId` had already been recorded and nothing was
   * written: the row, the amount and the balance are the first call's.
   */
  replayed: boolean;
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
 * the things a hand-written entry needs and an automatic one does not:
 *
 *  - **A named operator on the row.** `grantedByUserId`, so the ledger answers
 *    "who granted this" without a log search. The caller is already known to be
 *    in `auth.adminEmails` — `AdminGuard` is on the resolver — and the audit line
 *    names them too, but a log rotates and the ledger does not.
 *  - **A ceiling.** `billing.maxCreditGrantMicros` bounds the magnitude of one
 *    call the way `maxTopUpMicros` bounds one checkout: what this accepts is
 *    what a single fat finger, or a single stolen operator session, can do.
 *  - **A separate guard on taking credit away.** A negative amount has to be an
 *    `adjustment` and needs `billing.allowCreditDebits` to be on. On top of that
 *    the ledger refuses to overdraw an `adjustment`, so no sequence of calls
 *    here can push a balance below zero.
 *  - **A reason, always.** `grantedByUserId` says who and `reference` says it was
 *    by hand; `description` is the only field that says why, and an operator
 *    grant is the one ledger row with no outside event to explain it (SUP-398).
 *  - **A key the caller names.** `operator:<operator>:<requestId>`, so a
 *    submission that arrives twice — a proxy timeout, then the obvious retry —
 *    writes one row and reports `replayed`, while a second deliberate grant
 *    carries a second `requestId` and lands as a second row. A `requestId`
 *    reused against a *different* account is refused rather than answered: one
 *    decision moves credit on one account.
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
    const note = request.note.trim();
    if (!note) {
      // Every other field on the row says what happened; only this one says why.
      // An unexplained $100 is what opened SUP-389 — neither reclaimable nor
      // accountable — and a reason costs a sentence at the time and is
      // unrecoverable afterwards.
      throw new BadRequestException('Say why the credit is moving; the reason is kept on the ledger row.');
    }
    const requestId = request.requestId.trim();
    if (!requestId) {
      throw new BadRequestException('A requestId naming this decision is required.');
    }

    const target = await this.resolveTarget(request);

    const idempotencyKey = `operator:${request.operator.id}:${requestId}`;
    if (idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      // `credit_transactions.idempotencyKey` is a `varchar(128)`, and so is the
      // export bundle's. PostgreSQL would answer `22001` on an over-long key
      // while SQLite would store it whole, so the two drivers would disagree
      // about whether this call is even possible — refused here instead, where
      // the answer is the same on both.
      throw new BadRequestException(
        `The operator id and requestId together exceed the ${MAX_IDEMPOTENCY_KEY_LENGTH}-character ledger key; use a shorter requestId.`,
      );
    }

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
      description: `${this.label(request.kind, amountMicros)}${REASON_SEPARATOR}${note}`,
      grantedByUserId: request.operator.id,
      // Keyed on the operator's decision, which is the real-world event here the
      // way a generation or a Stripe event is elsewhere (SUP-398). Two deliberate
      // grants still both land, because a second decision arrives with a second
      // `requestId` — what this refuses to do twice is the *same* submission,
      // which no operator ever intends. A 504 after the row is written, then the
      // obvious retry, is the path that double-credited without it.
      idempotencyKey,
    });

    const recorded = entry.transaction;
    if (entry.replayed && recorded.workspaceId !== target.workspaceId) {
      // A `requestId` names one decision, and one decision moves credit on one
      // account. Reused against a second account the two disagree, and the only
      // honest answers are a refusal or a second row — the ledger has already
      // chosen not to write one, so this is the refusal. Papering over it with a
      // success would report a credit on an account that never got one: the
      // caller sent A's key with B's address and would read the first call's
      // amount, balance and reason back as if B had been credited (SUP-398).
      throw new BadRequestException(
        `requestId ${requestId} already recorded a credit movement on another account; ` +
          'a second account needs its own requestId.',
      );
    }
    this.logger.warn(
      entry.replayed
        ? `Credit movement replayed for ${request.operator.email} — request ${requestId} was already recorded ` +
            `as ${recorded.id} on workspace ${target.workspaceId}; nothing written, balance stays ` +
            `${microsToUsdString(entry.balanceMicros)} USD.`
        : `Credit ${amountMicros < 0 ? 'removed' : 'granted'} by ${request.operator.email} — ` +
            `${microsToUsdString(amountMicros)} USD as a ${request.kind} on workspace ${target.workspaceId}` +
            `${target.accountEmail ? ` (${target.accountEmail})` : ''}, ` +
            `balance now ${microsToUsdString(entry.balanceMicros)} USD: ${note}.`,
    );

    // Read off the row rather than echoing the arguments: on a replay the first
    // call's amount, kind and reason are what stands, and an operator who
    // retried with an edited amount has to be shown that, not their edit.
    return {
      creditTransactionId: recorded.id,
      // The row, not the request: the refusal above means the two can only ever
      // be the same workspace, and reading it from one place is what keeps that
      // true rather than merely likely.
      workspaceId: recorded.workspaceId,
      accountEmail: target.accountEmail,
      kind: recorded.kind as CreditGrantKind,
      amountMicros: recorded.amountMicros,
      balanceMicros: entry.balanceMicros,
      note: reasonOf(recorded.description) ?? note,
      createdAt: recorded.createdAt,
      replayed: entry.replayed,
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

    if (email && workspaceId) {
      throw new BadRequestException('Name the account to credit by accountEmail or by workspaceId, not both.');
    }
    if (!email && !workspaceId) {
      throw new BadRequestException('Name the account to credit, by either accountEmail or workspaceId.');
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
   *
   * Which means the match can be ambiguous: two accounts differing only in case
   * are two different people here, and taking the older one would credit a
   * stranger with nothing to say a choice had been made. An ambiguous address is
   * refused instead, and the operator names the workspace. Only a GraphQL-client
   * caller reaches it — the console always sends `workspaceId`.
   */
  private async accountOf(email: string): Promise<User | null> {
    const accounts = await this.dataSource
      .getRepository(User)
      .createQueryBuilder('account')
      .where('LOWER(account.email) = :email', { email: email.toLowerCase() })
      .orderBy('account.createdAt', 'ASC')
      .getMany();

    if (accounts.length > 1) {
      throw new BadRequestException(
        `${accounts.length} accounts differ only in the case of ${email}. ` +
          'Name the workspace to credit with workspaceId instead.',
      );
    }
    return accounts[0] ?? null;
  }

  /** The leading half of the row's description — what kind of movement this was. */
  private label(kind: CreditGrantKind, amountMicros: number): string {
    if (kind === 'grant') {
      return 'Credit granted by an operator';
    }
    return amountMicros < 0 ? 'Credit removed by an operator' : 'Credit adjusted by an operator';
  }
}

/** The separator between the label and the operator's reason in `description`. */
const REASON_SEPARATOR = ' · ';

/** `credit_transactions.idempotencyKey`, and the export bundle's copy of it. */
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

/**
 * The operator's reason back out of a row's `description`.
 *
 * Needed on a replay, where the reason that stands is the one written the first
 * time, and safe because this service composed the string. Null for a row
 * written by anything else, none of which carries a reason.
 */
function reasonOf(description: string | null): string | null {
  if (!description) {
    return null;
  }
  const at = description.indexOf(REASON_SEPARATOR);
  return at === -1 ? null : description.slice(at + REASON_SEPARATOR.length);
}
