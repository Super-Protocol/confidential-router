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
 * (ADR-002). Its denominator is `coverableRequests`, the requests served by
 * *this deployment's* endpoints, and not `requests`: a generation routed to an
 * external endpoint has no published bundle of ours to have been covered by,
 * and counting one as uncovered would report the single case where this router
 * verified the upstream itself as the least covered (ADR-008 §4). `requests`,
 * the token counts and `spendMicros` include every generation, external ones
 * included.
 *
 * Both halves of that fraction are therefore fields: a client holding only
 * `coveredRequests` and `requests` can phrase "0 of 34 covered" over a window
 * whose 34 generations were every one of them external — the ratio's own
 * denominator was 0 (SUP-421). Which is also why the ratio is nullable: no
 * coverable request means no ratio, and `0` would read as a missing proof.
 *
 * Money is micro-USD as a string, so no client rounds it.
 */
@ObjectType({ isAbstract: true })
abstract class ActivityTotalsModel {
  @Field(() => Int)
  requests!: number;

  @Field(() => Int, { description: 'Of `requests`, how many the endpoint had published evidence for.' })
  coveredRequests!: number;

  @Field(() => Int, {
    description:
      'Of `requests`, how many this deployment’s own endpoints served — the denominator of ' +
      '`evidenceCoverage`. The difference from `requests` went to external endpoints, which ' +
      'publish no bundle of ours and are reported as “verified by this router” instead.',
  })
  coverableRequests!: number;

  @Field(() => Int)
  promptTokens!: number;

  @Field(() => Int)
  completionTokens!: number;

  @Field(() => String, { description: 'Spend in micro-USD.' })
  spendMicros!: string;

  @Field(() => Float, {
    nullable: true,
    description:
      '0–1 over `coverableRequests`. Null when that is 0 — nothing in the window could have been ' +
      'covered, so there is no ratio; render it as “not applicable”, never as 0%. Generations ' +
      'routed to an external endpoint are outside this ratio, not counted as uncovered.',
  })
  evidenceCoverage!: number | null;
}

@ObjectType('ActivitySummary', { description: 'Totals for a period.' })
export class ActivitySummaryModel extends ActivityTotalsModel {
  @Field(() => Float, { nullable: true, description: 'Null when no request reported a first-token time.' })
  avgTimeToFirstTokenMs!: number | null;

  @Field(() => Float, { nullable: true })
  avgTokensPerSecond!: number | null;

  @Field(() => Int, {
    description:
      'Of `requests`, how many reported a first-token time — the sample `avgTimeToFirstTokenMs` averages. ' +
      'A request that was not streamed never reports one.',
  })
  timedRequests!: number;

  @Field(() => Int, {
    description:
      'Of `requests`, how many reported a generation rate — the sample `avgTokensPerSecond` averages. ' +
      'Always at most `timedRequests`: a rate also needs a window large enough to divide.',
  })
  ratedRequests!: number;
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
