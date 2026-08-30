import { Field, ID, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import type { ModelCapability } from '../../../db/entities/model.entity.js';
import { EndpointModel } from './endpoint.model.js';

/** GraphQL spelling of `ModelCapability`; the values are what the config and the database hold. */
export const ModelCapabilityEnum = {
  CHAT: 'chat',
  COMPLETIONS: 'completions',
  EMBEDDINGS: 'embeddings',
} as const satisfies Record<string, ModelCapability>;

registerEnumType(ModelCapabilityEnum, { name: 'ModelCapability' });

@ObjectType('Pricing', {
  description: 'Frozen at request time onto every generation, so a config change cannot rewrite history.',
})
export class PricingModel {
  @Field(() => String, { description: 'Micro-USD per 1M prompt tokens, as a string so no precision is lost in JSON.' })
  promptPer1m!: string;

  @Field(() => String, { description: 'Micro-USD per 1M completion tokens.' })
  completionPer1m!: string;
}

/**
 * One routable model. The GraphQL type is `Model`; the class is `LlmModel` so it
 * does not collide with the TypeORM entity of the same name.
 */
@ObjectType('Model', { description: 'A model the router can route to, as declared in the router config.' })
export class LlmModel {
  @Field(() => ID, { description: 'The public model id, e.g. meta/llama-3.3-70b-instruct:tdx.' })
  id!: string;

  @Field(() => String, { description: 'Same value as `id`; the console calls it the slug.' })
  slug!: string;

  @Field()
  name!: string;

  @Field(() => Int)
  contextLength!: number;

  @Field(() => [ModelCapabilityEnum])
  capabilities!: ModelCapability[];

  @Field(() => PricingModel)
  pricing!: PricingModel;

  @Field(() => EndpointModel, { description: 'The endpoint that serves it — what the user attests.' })
  endpoint!: EndpointModel;

  @Field(() => String, { description: 'Denormalised from the endpoint so a model list needs no join.' })
  tee!: string;
}
