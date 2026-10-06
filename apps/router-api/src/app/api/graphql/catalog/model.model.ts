import { Field, ID, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import type { ModelCapability, ModelOrigin } from '../../../db/entities/model.entity.js';
import { EndpointModel } from './endpoint.model.js';
import { ExternalUpstreamModel } from './external-upstream.model.js';

/** GraphQL spelling of `ModelCapability`; the values are what the config and the database hold. */
export const ModelCapabilityEnum = {
  CHAT: 'chat',
  COMPLETIONS: 'completions',
  EMBEDDINGS: 'embeddings',
} as const satisfies Record<string, ModelCapability>;

registerEnumType(ModelCapabilityEnum, { name: 'ModelCapability' });

/**
 * Where a listed model actually runs, and therefore which of the two attestation
 * vocabularies applies to it.
 *
 * An enum rather than a boolean or a description, because this is the value a
 * third-party consumer branches on and the contract rule is that such a value
 * lives at the type level (ADR-008 §1). The values are the ones the `models`
 * table already holds, so there is one spelling of the distinction in this
 * repository rather than three.
 */
export const ModelOriginEnum = {
  CONFIG: 'config',
  EXTERNAL: 'external',
} as const satisfies Record<string, ModelOrigin>;

registerEnumType(ModelOriginEnum, {
  name: 'ModelOrigin',
  description:
    'CONFIG is a model inside this deployment’s own cluster space, declared in the router config and therefore ' +
    'covered by the canonical snapshot a user pins. EXTERNAL is a model in another deployment, reached through ' +
    'this router’s attesting egress — the pin covers the verifier, not the upstream (ADR-008 §1).',
});

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
 * One listed model. The GraphQL type is `Model`; the class is `LlmModel` so it
 * does not collide with the TypeORM entity of the same name.
 *
 * Two kinds share it, and {@link ModelOriginEnum} is the discriminator: a model
 * declared in the router config, and one an operator registered on an external
 * endpoint (ADR-008). What they share is everything a catalogue is for — id,
 * price, context, capabilities. What they do not share is the attestation they
 * carry, and that is kept apart by the nullability of two fields rather than by a
 * convention: `endpoint` for ours, `externalUpstream` for theirs, never both.
 */
@ObjectType('Model', {
  description:
    'A model the router can route to: declared in the router config, or registered on an external endpoint and ' +
    'attested by this router (ADR-008). `origin` says which, and decides which of `endpoint` / `externalUpstream` ' +
    'is populated.',
})
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

  @Field(() => ModelOriginEnum, { description: 'Whether this model runs in this deployment or in another one.' })
  origin!: ModelOrigin;

  /**
   * Availability, which for an external model is the fail-closed rule of decision
   * 5 seen from the catalogue: a model whose endpoint holds no live admitting
   * verdict is listed and is not routable.
   *
   * It is the one fact about an external model's standing an *anonymous* caller
   * gets (SUP-221 ruling 3) — name, price, availability, and no verdict detail —
   * which is why it is a field of its own rather than something a reader derives
   * from `externalUpstream.status`, a field that caller cannot see.
   */
  @Field(() => Boolean, {
    description:
      'Whether this router will route to it right now. Always true for a CONFIG model; for an EXTERNAL one it ' +
      'is false unless the endpoint holds a live verdict admitting it.',
  })
  available!: boolean;

  /**
   * Null for an external model: there is no `endpoints` row for someone else's
   * deployment, and this router publishes no evidence for it.
   *
   * It was `Endpoint!` before ADR-008. Widening it rather than inventing a
   * stand-in row is the honest shape — a synthetic endpoint would carry an
   * `evidenceState` about a hostname this deployment does not publish, which is
   * exactly the blend of the two vocabularies §1 forbids.
   */
  @Field(() => EndpointModel, {
    nullable: true,
    description:
      'The endpoint that serves it — what the user attests. Null for an EXTERNAL model: this router publishes ' +
      'no evidence for another deployment’s hostname. Read `externalUpstream` instead.',
  })
  endpoint!: EndpointModel | null;

  @Field(() => ExternalUpstreamModel, {
    nullable: true,
    description:
      'The upstream behind an EXTERNAL model. Null for a CONFIG model, and null for an anonymous caller ' +
      'whatever the origin (SUP-221 ruling 3).',
  })
  externalUpstream!: ExternalUpstreamModel | null;

  @Field(() => String, {
    nullable: true,
    description:
      'Denormalised from the endpoint so a model list needs no join. Null for an EXTERNAL model: the operator ' +
      'declares no TEE label for another deployment’s hardware, and a measurement admits a cloud rather than ' +
      'naming its silicon.',
  })
  tee!: string | null;
}
