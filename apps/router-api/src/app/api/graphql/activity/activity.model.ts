import { Field, Float, GraphQLISODateTime, ID, Int, ObjectType, registerEnumType } from '@nestjs/graphql';

export enum BucketEnum {
  HOUR = 'hour',
  DAY = 'day',
}

registerEnumType(BucketEnum, {
  name: 'Bucket',
  description: 'Granularity of an activity series. Buckets start on UTC boundaries.',
});

/**
 * Fields every activity aggregate carries.
 *
 * `evidenceCoverage` is the share of requests served while the endpoint had
 * published evidence — a fact about publication, never a verdict about validity
 * (ADR-002). Money is micro-USD as a string, so no client rounds it.
 */
@ObjectType({ isAbstract: true })
abstract class ActivityTotalsModel {
  @Field(() => Int)
  requests!: number;

  @Field(() => Int, { description: 'Of `requests`, how many the endpoint had published evidence for.' })
  coveredRequests!: number;

  @Field(() => Int)
  promptTokens!: number;

  @Field(() => Int)
  completionTokens!: number;

  @Field(() => String, { description: 'Spend in micro-USD.' })
  spendMicros!: string;

  @Field(() => Float, { description: '0–1. Zero when there were no requests.' })
  evidenceCoverage!: number;
}

@ObjectType('ActivitySummary', { description: 'Totals for a period.' })
export class ActivitySummaryModel extends ActivityTotalsModel {
  @Field(() => Float, { nullable: true, description: 'Null when no request reported a first-token time.' })
  avgTimeToFirstTokenMs!: number | null;

  @Field(() => Float, { nullable: true })
  avgTokensPerSecond!: number | null;
}

@ObjectType('ActivityPoint', { description: 'One bucket of an activity series. Quiet buckets are zeroes, not gaps.' })
export class ActivityPointModel extends ActivityTotalsModel {
  @Field(() => GraphQLISODateTime, { description: 'Start of the bucket.' })
  bucket!: Date;
}

@ObjectType('KeyUsage', { description: 'What one API key spent in a period.' })
export class KeyUsageModel extends ActivityTotalsModel {
  @Field(() => ID, { nullable: true, description: 'Null once the key has been deleted.' })
  apiKeyId!: string | null;

  @Field(() => String)
  name!: string;

  @Field(() => String, { nullable: true })
  prefix!: string | null;
}

@ObjectType('ModelUsage', { description: 'What one model was used for in a period, most expensive first.' })
export class ModelUsageModel extends ActivityTotalsModel {
  @Field(() => ID)
  modelId!: string;

  @Field(() => String)
  name!: string;
}
