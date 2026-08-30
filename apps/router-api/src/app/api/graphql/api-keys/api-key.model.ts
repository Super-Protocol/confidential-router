import { Field, GraphQLISODateTime, ID, InputType, Int, ObjectType } from '@nestjs/graphql';
import { ArrayMaxSize, IsArray, IsInt, IsOptional, IsString, Length, Matches, Max, Min } from 'class-validator';

/** Longest a caller may make a scope list; the catalogue is nowhere near this. */
const MAX_SCOPE_ENTRIES = 200;

/** Money crosses GraphQL as a decimal string of micro-USD — see `console-graphql.md`. */
const MICROS = /^\d{1,15}$/;

@ObjectType('ApiKey', { description: 'A /v1 credential. The secret itself is returned only at creation.' })
export class ApiKeyModel {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field(() => String, { description: 'Leading characters of the key, for display: `sk-tee-v1-4f`.' })
  prefix!: string;

  @Field(() => [String], {
    nullable: true,
    description: 'Model ids this key may call. Null means every model in the catalogue.',
  })
  modelScope!: string[] | null;

  @Field(() => String, { nullable: true, description: 'Spend ceiling in micro-USD.' })
  spendLimitMicros!: string | null;

  @Field(() => String, { description: 'Micro-USD metered against this key so far.' })
  spentTotalMicros!: string;

  @Field(() => Int, { nullable: true })
  requestsPerMinute!: number | null;

  @Field(() => Int, { nullable: true })
  tokensPerMinute!: number | null;

  @Field(() => GraphQLISODateTime, { nullable: true })
  expiresAt!: Date | null;

  @Field(() => GraphQLISODateTime, { nullable: true })
  lastUsedAt!: Date | null;

  @Field(() => GraphQLISODateTime, { nullable: true })
  revokedAt!: Date | null;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;
}

@ObjectType('ApiKeyCreated', { description: 'The one and only time the plaintext key is available.' })
export class ApiKeyCreatedModel {
  @Field(() => ApiKeyModel)
  key!: ApiKeyModel;

  @Field(() => String, { description: 'The full key. It is not stored and cannot be shown again.' })
  secret!: string;
}

@InputType('CreateApiKeyInput')
export class CreateApiKeyInputModel {
  @Field(() => ID)
  @IsString()
  workspaceId!: string;

  @Field()
  @IsString()
  @Length(1, 255)
  name!: string;

  @Field(() => [String], { nullable: true, description: 'Restrict the key to these model ids. Omit for all.' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_SCOPE_ENTRIES)
  @IsString({ each: true })
  modelIds?: string[];

  @Field(() => String, { nullable: true })
  @IsOptional()
  @Matches(MICROS)
  spendLimitMicros?: string;

  @Field(() => GraphQLISODateTime, { nullable: true })
  @IsOptional()
  expiresAt?: Date;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  requestsPerMinute?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1_000_000_000)
  tokensPerMinute?: number;
}

@InputType('UpdateApiKeyInput')
export class UpdateApiKeyInputModel {
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @Length(1, 255)
  name?: string;

  @Field(() => [String], { nullable: true, description: 'Replaces the scope. An empty list clears it.' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_SCOPE_ENTRIES)
  @IsString({ each: true })
  modelIds?: string[];

  @Field(() => String, { nullable: true })
  @IsOptional()
  @Matches(MICROS)
  spendLimitMicros?: string;

  @Field(() => GraphQLISODateTime, { nullable: true })
  @IsOptional()
  expiresAt?: Date;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  requestsPerMinute?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1_000_000_000)
  tokensPerMinute?: number;
}
