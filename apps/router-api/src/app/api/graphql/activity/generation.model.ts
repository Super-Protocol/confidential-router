import { Field, Float, GraphQLISODateTime, ID, InputType, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import { IsArray, IsDate, IsEnum, IsOptional, IsString } from 'class-validator';
import { PageInfoModel } from '../common/page-info.model.js';

export enum GenerationStatusEnum {
  OK = 'ok',
  ERROR = 'error',
  ABORTED = 'aborted',
}

registerEnumType(GenerationStatusEnum, { name: 'GenerationStatus' });

export enum GenerationSortFieldEnum {
  CREATED_AT = 'createdAt',
  COST = 'costMicros',
  LATENCY = 'latencyMs',
  TOTAL_TOKENS = 'totalTokens',
}

registerEnumType(GenerationSortFieldEnum, { name: 'GenerationSortField' });

export enum SortDirectionEnum {
  ASC = 'ASC',
  DESC = 'DESC',
}

registerEnumType(SortDirectionEnum, { name: 'SortDirection' });

/**
 * One metered request.
 *
 * No prompt and no completion, here or anywhere: the router forwards bodies to
 * LiteLLM and never persists them (`docs/threat-model.md`). `modelId` and
 * `apiKeyId` are ids plus a resolved display name rather than object references
 * — the `Model` and `ApiKey` object types arrive with SUP-73 and SUP-74, and a
 * name is what the Logs table renders.
 */
@ObjectType('Generation', { description: 'One metered request. Never any prompt or completion content.' })
export class GenerationModel {
  @Field(() => ID)
  id!: string;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => ID)
  modelId!: string;

  @Field(() => String)
  modelName!: string;

  @Field(() => ID)
  endpointId!: string;

  @Field(() => ID, { nullable: true })
  apiKeyId!: string | null;

  @Field(() => String, { nullable: true, description: 'Null once the key has been deleted.' })
  apiKeyName!: string | null;

  @Field(() => Int)
  promptTokens!: number;

  @Field(() => Int)
  completionTokens!: number;

  @Field(() => String, { description: 'Cost in micro-USD.' })
  costMicros!: string;

  @Field(() => Int)
  latencyMs!: number;

  @Field(() => Int, { nullable: true })
  timeToFirstTokenMs!: number | null;

  @Field(() => Float, { nullable: true })
  tokensPerSecond!: number | null;

  @Field(() => Boolean)
  streamed!: boolean;

  @Field(() => GenerationStatusEnum)
  status!: GenerationStatusEnum;

  @Field(() => String, { nullable: true })
  finishReason!: string | null;

  @Field(() => String, { nullable: true })
  errorCode!: string | null;

  @Field(() => ID, { nullable: true, description: 'The snapshot the endpoint had published when this was served.' })
  evidenceSnapshotId!: string | null;

  @Field(() => String, { nullable: true })
  evidenceDigest!: string | null;
}

@InputType('GenerationFilter')
export class GenerationFilterInput {
  @Field(() => GraphQLISODateTime, { nullable: true })
  @IsOptional()
  @IsDate()
  from?: Date;

  @Field(() => GraphQLISODateTime, { nullable: true })
  @IsOptional()
  @IsDate()
  to?: Date;

  @Field(() => [ID], { nullable: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  modelIds?: string[];

  @Field(() => [ID], { nullable: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  apiKeyIds?: string[];

  @Field(() => [GenerationStatusEnum], { nullable: true })
  @IsOptional()
  @IsArray()
  @IsEnum(GenerationStatusEnum, { each: true })
  statuses?: GenerationStatusEnum[];
}

@InputType('GenerationSort')
export class GenerationSortInput {
  @Field(() => GenerationSortFieldEnum, { defaultValue: GenerationSortFieldEnum.CREATED_AT })
  @IsEnum(GenerationSortFieldEnum)
  field!: GenerationSortFieldEnum;

  @Field(() => SortDirectionEnum, { defaultValue: SortDirectionEnum.DESC })
  @IsEnum(SortDirectionEnum)
  direction!: SortDirectionEnum;
}

@ObjectType('GenerationEdge')
export class GenerationEdgeModel {
  @Field(() => String)
  cursor!: string;

  @Field(() => GenerationModel)
  node!: GenerationModel;
}

@ObjectType('GenerationConnection')
export class GenerationConnectionModel {
  @Field(() => [GenerationEdgeModel])
  edges!: GenerationEdgeModel[];

  @Field(() => PageInfoModel)
  pageInfo!: PageInfoModel;

  @Field(() => Int)
  totalCount!: number;
}
