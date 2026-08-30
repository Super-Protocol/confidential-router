import { ArgsType, Field, GraphQLISODateTime, ID, Int } from '@nestjs/graphql';
import { Type } from 'class-transformer';
import { IsDate, IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, Max, Min, ValidateNested } from 'class-validator';
import { BucketEnum } from './activity.model.js';
import { GenerationFilterInput, GenerationSortInput } from './generation.model.js';

/**
 * Arguments are grouped into `@ArgsType` classes rather than listed one per
 * parameter: the validation and the workspace check then live on one object, and
 * a resolver method stays within the argument budget the linter enforces.
 *
 * Every field carries a class-validator decorator because the global
 * `ValidationPipe` runs with `whitelist` — an undecorated field would be
 * stripped from the request rather than rejected, which is the failure mode
 * hardest to see from the client.
 */
@ArgsType()
export class ActivityRangeArgs {
  @Field(() => ID)
  @IsString()
  @IsNotEmpty()
  workspaceId!: string;

  @Field(() => GraphQLISODateTime, { description: 'Inclusive start of the range.' })
  @IsDate()
  from!: Date;

  @Field(() => GraphQLISODateTime, { description: 'Exclusive end of the range.' })
  @IsDate()
  to!: Date;
}

@ArgsType()
export class ActivitySeriesArgs extends ActivityRangeArgs {
  @Field(() => BucketEnum)
  @IsEnum(BucketEnum)
  bucket!: BucketEnum;
}

@ArgsType()
export class TopKeysArgs extends ActivityRangeArgs {
  @Field(() => Int, { defaultValue: 5 })
  @IsInt()
  @Min(1)
  @Max(50)
  limit!: number;
}

@ArgsType()
export class UsageByModelArgs extends ActivityRangeArgs {
  @Field(() => Int, { nullable: true, description: 'Omit for every model; set it for "top models by spend".' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

@ArgsType()
export class SignedResponseDaysArgs {
  @Field(() => ID)
  @IsString()
  @IsNotEmpty()
  workspaceId!: string;

  @Field(() => Int, { defaultValue: 365 })
  @IsInt()
  @Min(1)
  @Max(400)
  days!: number;
}

@ArgsType()
export class GenerationsArgs {
  @Field(() => ID)
  @IsString()
  @IsNotEmpty()
  workspaceId!: string;

  @Field(() => GenerationFilterInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => GenerationFilterInput)
  filter?: GenerationFilterInput;

  @Field(() => GenerationSortInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => GenerationSortInput)
  sort?: GenerationSortInput;

  @Field(() => Int, { defaultValue: 50 })
  @IsInt()
  @Min(1)
  @Max(200)
  first!: number;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  after?: string;
}
