import { BadRequestException, UseGuards } from '@nestjs/common';
import { Args, Mutation, Resolver } from '@nestjs/graphql';
import { AdminGuard, CurrentUser, SessionGuard, type SessionUser } from '../../../auth/index.js';
import {
  type CreditGrantKind,
  CreditGrantService,
  InvalidMicroAmountError,
  parseMicros,
} from '../../../billing/index.js';
import { AdminCreditGrantKindEnum, CreditGrantModel, GrantCreditInputModel } from './credit-grant.model.js';

/**
 * The operator's credit grant (SUP-406).
 *
 * A resolver of its own rather than a mutation on {@link CreditsResolver},
 * because the guards are the difference: everything there is a *member* acting on
 * their own workspace, and this is an operator acting on somebody else's. Mixing
 * the two in one class means one `@UseGuards` per method and a 403 one forgotten
 * decorator away — the same reason the invitation admin surface is its own
 * resolver.
 */
@Resolver()
@UseGuards(SessionGuard, AdminGuard)
export class CreditGrantResolver {
  constructor(private readonly grants: CreditGrantService) {}

  @Mutation(() => CreditGrantModel, {
    description:
      'Puts credit on an existing account, or corrects a balance, as one audited ledger entry naming the ' +
      'operator. Bounded by billing.maxCreditGrantMicros. Restricted to auth.adminEmails.',
  })
  async grantCredit(
    @CurrentUser() user: SessionUser,
    @Args('input') input: GrantCreditInputModel,
  ): Promise<CreditGrantModel> {
    const result = await this.grants.grant({
      accountEmail: input.accountEmail ?? null,
      workspaceId: input.workspaceId ?? null,
      kind: input.kind as CreditGrantKind,
      amountMicros: amountOf(input.amountMicros),
      note: input.note ?? null,
      operator: { id: user.id, email: user.email },
    });
    return {
      creditTransactionId: result.creditTransactionId,
      workspaceId: result.workspaceId,
      accountEmail: result.accountEmail,
      kind: result.kind === 'grant' ? AdminCreditGrantKindEnum.GRANT : AdminCreditGrantKindEnum.ADJUSTMENT,
      amountMicros: String(result.amountMicros),
      balanceMicros: String(result.balanceMicros),
      note: result.note,
      createdAt: result.createdAt,
    };
  }
}

/**
 * `amountMicros` as a number, or a `400`.
 *
 * The input's regex admits any run of digits, so an amount past
 * `Number.MAX_SAFE_INTEGER` reaches `parseMicros` and comes back as an
 * `InvalidMicroAmountError` — which is not an `HttpException`, so Apollo would
 * mask it as an internal error and tell the operator nothing. SUP-406 asks this
 * mutation to fail cleanly; a number nobody could mean is as much a bad request
 * as a letter in the field.
 */
function amountOf(value: string): number {
  try {
    return parseMicros(value, 'amountMicros');
  } catch (error) {
    if (error instanceof InvalidMicroAmountError) {
      throw new BadRequestException(error.message);
    }
    throw error;
  }
}
