import { Field, GraphQLISODateTime, ID, InputType, ObjectType, registerEnumType } from '@nestjs/graphql';
import { IsEmail, IsEnum, IsOptional, IsString, Length, Matches } from 'class-validator';

/*
 * The operator credit grant (SUP-406). Behind `auth.adminEmails`; the resolver
 * is where that is enforced.
 */

/**
 * Which ledger kind the entry is written as.
 *
 * One mutation carrying the kind rather than two mutations, because the kind is
 * already the ledger's own discriminator for exactly this distinction —
 * `REQUIRED_SIGN` in `ledger.service.ts` says a `grant` must be positive and an
 * `adjustment` may be either way — and the audit trail an operator reads is the
 * `credit_transactions` row, where `kind` is a column. Two mutations would have
 * put the same fact in the mutation name instead, duplicated the bound, the
 * target resolution and the audit line between them, and still have written the
 * same two kinds to the same column.
 */
export enum AdminCreditGrantKindEnum {
  /** New credit nobody paid for: a top-up for a tester, a goodwill grant. */
  GRANT = 'grant',
  /** A correction. The only kind that may carry a negative amount. */
  ADJUSTMENT = 'adjustment',
}

registerEnumType(AdminCreditGrantKindEnum, {
  name: 'AdminCreditGrantKind',
  description:
    'How an operator credit movement is recorded in the ledger. GRANT is credit nobody paid for; ' +
    'ADJUSTMENT is a correction and the only kind that may remove credit.',
});

@InputType('GrantCreditInput')
export class GrantCreditInputModel {
  @Field(() => String, {
    nullable: true,
    description: 'The account holder to credit. Exactly one of this and `workspaceId`.',
  })
  @IsOptional()
  @IsEmail()
  accountEmail?: string | null;

  @Field(() => ID, {
    nullable: true,
    description: 'The workspace to credit, when the caller already has its id. Exactly one of this and `accountEmail`.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  workspaceId?: string | null;

  @Field(() => String, {
    description:
      'Signed micro-USD as an integer string, bounded by `billing.maxCreditGrantMicros`. ' +
      'A negative amount removes credit and needs kind ADJUSTMENT and `billing.allowCreditDebits`.',
  })
  @Matches(/^-?\d+$/, { message: 'amountMicros must be an integer number of micro-USD, optionally negative.' })
  amountMicros!: string;

  @Field(() => AdminCreditGrantKindEnum, { defaultValue: AdminCreditGrantKindEnum.GRANT })
  @IsEnum(AdminCreditGrantKindEnum)
  kind!: AdminCreditGrantKindEnum;

  @Field(() => String, {
    description:
      'Why the credit is moving, kept on the ledger row and shown to the account holder. Required: it is the ' +
      'only field that explains an entry nobody paid for.',
  })
  @IsString()
  @Length(1, 400)
  note!: string;

  @Field(() => String, {
    description:
      "The caller's name for this decision — a UUID the console mints when the dialog opens. The same value " +
      'replays the first call instead of crediting twice; a second deliberate grant sends a new one.',
  })
  @IsString()
  @Length(1, 64)
  @Matches(/^[A-Za-z0-9_.-]+$/, {
    message: 'requestId may contain letters, digits, dot, dash and underscore only.',
  })
  requestId!: string;
}

@ObjectType('CreditGrant', { description: 'The ledger entry an operator grant wrote, and the balance it produced.' })
export class CreditGrantModel {
  @Field(() => ID, { description: 'The `credit_transactions` row.' })
  creditTransactionId!: string;

  @Field(() => ID)
  workspaceId!: string;

  @Field(() => String, { nullable: true, description: 'Set when the workspace was named by its account holder.' })
  accountEmail!: string | null;

  @Field(() => AdminCreditGrantKindEnum)
  kind!: AdminCreditGrantKindEnum;

  @Field(() => String, { description: 'Signed micro-USD, as written.' })
  amountMicros!: string;

  @Field(() => String, { description: 'The workspace balance after the entry, in micro-USD.' })
  balanceMicros!: string;

  @Field(() => String, { description: 'The reason recorded on the row — the first call’s, on a replay.' })
  note!: string;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => Boolean, {
    description:
      'True when this requestId had already been recorded: nothing was written and the balance is unchanged. ' +
      'The console says “already recorded” rather than reporting a second success.',
  })
  replayed!: boolean;
}
