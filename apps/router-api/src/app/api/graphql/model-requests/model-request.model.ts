import { Field, GraphQLISODateTime, ID, InputType, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional, IsString, Length } from 'class-validator';
import { MAX_MODEL_NAME_LENGTH } from '../../../model-requests/index.js';

/**
 * Trim before the length check, not after.
 *
 * `@Length(1, …)` on the raw string would accept three spaces, and what gets
 * stored is the trimmed one — an empty name, and an empty grouping key the
 * export cannot explain.
 */
const trimmed = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

/** How long a note may be. Long enough for a use case, short enough not to be an essay. */
const MAX_NOTE_LENGTH = 2000;

/**
 * Which screen the request was raised from.
 *
 * The SDL spells them in GraphQL's screaming case and the database in the
 * analytics taxonomy's snake case; `SOURCES` below is the one place the two
 * meet, so neither vocabulary can drift without a compile error.
 */
export enum ModelRequestSourceEnum {
  MODELS_PAGE = 'MODELS_PAGE',
  EMPTY_STATE = 'EMPTY_STATE',
  DASHBOARD = 'DASHBOARD',
}

registerEnumType(ModelRequestSourceEnum, {
  name: 'ModelRequestSource',
  description: 'Where the "request a model" dialog was opened from.',
});

@InputType('RequestModelInput')
export class RequestModelInputModel {
  @Field(() => String, { description: 'A model name or a Hugging Face id, as the requester typed it.' })
  @trimmed()
  @IsString()
  @Length(1, MAX_MODEL_NAME_LENGTH)
  model!: string;

  @Field(() => String, { nullable: true, description: 'What they want it for. Never leaves the database.' })
  @IsOptional()
  @trimmed()
  @IsString()
  @Length(0, MAX_NOTE_LENGTH)
  note?: string;

  @Field(() => Boolean, { nullable: true, description: 'Tell them when it is served. Defaults to false.' })
  @IsOptional()
  @IsBoolean()
  notify?: boolean;

  @Field(() => ModelRequestSourceEnum)
  @IsEnum(ModelRequestSourceEnum)
  source!: ModelRequestSourceEnum;
}

@ObjectType('ModelRequestReceipt', {
  description: 'Proof that one request was filed, so the dialog can say so rather than guess.',
})
export class ModelRequestReceiptModel {
  @Field(() => ID)
  id!: string;

  @Field(() => String, { description: 'The name as stored — trimmed, otherwise exactly what was typed.' })
  requestedModel!: string;

  @Field(() => Boolean)
  notify!: boolean;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;
}

@ObjectType('ModelDemand', { description: 'How many people have asked for one model. Operators only.' })
export class ModelDemandModel {
  @Field(() => String, { description: 'The most recent spelling anyone used, for a table a human reads.' })
  model!: string;

  @Field(() => String, { description: 'The key the rows were grouped on: lower-cased, Hugging Face URLs stripped.' })
  normalisedModel!: string;

  @Field(() => Int, { description: 'Requests filed. One person asking four times counts four.' })
  requests!: number;

  @Field(() => Int, { description: 'Distinct accounts — the number that tells demand from enthusiasm.' })
  requesters!: number;

  @Field(() => Int, { description: 'Requests whose author asked to be told when it is served.' })
  notifyRequests!: number;

  @Field(() => GraphQLISODateTime)
  firstRequestedAt!: Date;

  @Field(() => GraphQLISODateTime)
  lastRequestedAt!: Date;
}
