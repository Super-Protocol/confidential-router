import { Field, ID, InputType } from '@nestjs/graphql';
import { Type } from 'class-transformer';
import { IsNotEmpty, IsNumberString, IsString, ValidateNested } from 'class-validator';
import { AutoTopUpInput } from './credits.model.js';

/**
 * Mutations take a single input object rather than loose arguments: the
 * workspace id and the payload then travel together, which is what the
 * membership check reads.
 */
@InputType('CreateCheckoutInput')
export class CreateCheckoutInput {
  @Field(() => ID)
  @IsString()
  @IsNotEmpty()
  workspaceId!: string;

  @Field(() => String, { description: 'Micro-USD, a whole number of cents, at least `minTopUpMicros`.' })
  @IsNumberString({ no_symbols: true })
  amountMicros!: string;
}

@InputType('SetAutoTopUpInput')
export class SetAutoTopUpInput {
  @Field(() => ID)
  @IsString()
  @IsNotEmpty()
  workspaceId!: string;

  @Field(() => AutoTopUpInput)
  @ValidateNested()
  @Type(() => AutoTopUpInput)
  settings!: AutoTopUpInput;
}
