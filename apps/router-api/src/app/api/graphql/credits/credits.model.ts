import { ArgsType, Field, GraphQLISODateTime, ID, InputType, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import { IsBoolean, IsInt, IsNotEmpty, IsNumberString, IsOptional, IsString, Max, Min } from 'class-validator';
import { PageInfoModel } from '../common/page-info.model.js';

export enum CreditTransactionKindEnum {
  PURCHASE = 'purchase',
  USAGE = 'usage',
  REFUND = 'refund',
  ADJUSTMENT = 'adjustment',
  AUTO_TOPUP = 'auto_topup',
}

registerEnumType(CreditTransactionKindEnum, { name: 'CreditTransactionKind' });

@ObjectType('CreditTransaction', { description: 'One entry of the append-only credits ledger.' })
export class CreditTransactionModel {
  @Field(() => ID)
  id!: string;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => CreditTransactionKindEnum)
  kind!: CreditTransactionKindEnum;

  @Field(() => String, { description: 'Signed micro-USD: credits positive, usage negative.' })
  amountMicros!: string;

  @Field(() => String, { nullable: true, description: 'Payment id or generation id, depending on the kind.' })
  reference!: string | null;

  @Field(() => String, {
    nullable: true,
    description: 'Human-readable note; carries the receipt link when there is one.',
  })
  description!: string | null;
}

@ObjectType('CreditTransactionEdge')
export class CreditTransactionEdgeModel {
  @Field(() => String)
  cursor!: string;

  @Field(() => CreditTransactionModel)
  node!: CreditTransactionModel;
}

@ObjectType('CreditTransactionConnection')
export class CreditTransactionConnectionModel {
  @Field(() => [CreditTransactionEdgeModel])
  edges!: CreditTransactionEdgeModel[];

  @Field(() => PageInfoModel)
  pageInfo!: PageInfoModel;

  @Field(() => Int)
  totalCount!: number;
}

@ObjectType('AutoTopUp', { description: 'Charge the saved card when the balance falls below the threshold.' })
export class AutoTopUpModel {
  @Field(() => Boolean)
  enabled!: boolean;

  @Field(() => String, { nullable: true })
  thresholdMicros!: string | null;

  @Field(() => String, { nullable: true })
  amountMicros!: string | null;

  @Field(() => GraphQLISODateTime, { nullable: true })
  lastChargedAt!: Date | null;

  @Field(() => Boolean, { description: 'False when the configured payment provider cannot charge a saved card.' })
  available!: boolean;
}

@ObjectType('CreditBalance', { description: 'The Credits screen header: balance, admission and top-up settings.' })
export class CreditBalanceModel {
  @Field(() => ID)
  workspaceId!: string;

  @Field(() => String, { description: 'Micro-USD. Negative after an overdrawing generation.' })
  balanceMicros!: string;

  @Field(() => Boolean, { description: 'False once `/v1` starts answering 402 insufficient_credits.' })
  spendable!: boolean;

  @Field(() => String)
  minTopUpMicros!: string;

  @Field(() => AutoTopUpModel)
  autoTopUp!: AutoTopUpModel;
}

@ObjectType('CheckoutSession', { description: 'Where to send the browser to pay.' })
export class CheckoutSessionModel {
  @Field(() => String)
  url!: string;

  @Field(() => String, { description: "The provider's own id for the session." })
  ref!: string;
}

@InputType('AutoTopUpInput')
export class AutoTopUpInput {
  @Field(() => Boolean)
  @IsBoolean()
  enabled!: boolean;

  @Field(() => String, { nullable: true, description: 'Micro-USD. Required when enabling.' })
  @IsOptional()
  @IsNumberString({ no_symbols: true })
  thresholdMicros?: string;

  @Field(() => String, { nullable: true, description: 'Micro-USD. Required when enabling.' })
  @IsOptional()
  @IsNumberString({ no_symbols: true })
  amountMicros?: string;
}

@ArgsType()
export class CreditTransactionsArgs {
  @Field(() => ID)
  @IsString()
  @IsNotEmpty()
  workspaceId!: string;

  @Field(() => Int, { defaultValue: 20 })
  @IsInt()
  @Min(1)
  @Max(200)
  first!: number;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  after?: string;
}
