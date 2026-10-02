import { Field, ID, Int, ObjectType } from '@nestjs/graphql';
import type { EvidenceState } from '../../../evidence/index.js';
import { EvidenceSnapshotModel, EvidenceStateEnum } from './evidence.model.js';

@ObjectType('DeclaredImage', {
  description:
    'One container image the operator declares this endpoint runs, pinned by digest. A statement of ' +
    'intent from the config, never a verification result — the console compares it against the digests ' +
    "in the endpoint's signed deployment evidence and reports the difference.",
})
export class DeclaredImageModel {
  @Field(() => String, { description: 'Image reference without tag or digest.' })
  name!: string;

  @Field(() => String, { description: 'sha256:<64 hex>.' })
  digest!: string;
}

@ObjectType('Endpoint', {
  description:
    'A router hostname the platform publishes evidence for. Projected from the router config; never ' +
    'created or edited through this API.',
})
export class EndpointModel {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field()
  hostname!: string;

  @Field(() => String, { description: 'Operator-declared TEE label from the config. Informational, never a claim.' })
  tee!: string;

  @Field(() => [DeclaredImageModel], {
    nullable: true,
    description:
      'The operator-declared image allow-list, or null when the config declares none. Null and an empty ' +
      'list mean different things: null is "nothing was declared", an empty list is "this endpoint is ' +
      'declared to run nothing".',
  })
  declaredImages!: DeclaredImageModel[] | null;

  @Field(() => EvidenceSnapshotModel, {
    nullable: true,
    description: 'The most recently issued bundle this router has fetched, or null if there is none.',
  })
  latestEvidence!: EvidenceSnapshotModel | null;

  @Field(() => EvidenceStateEnum)
  evidenceState!: EvidenceState;

  @Field(() => Int, { description: 'Prompt + completion tokens the viewer’s workspace routed here in 30 days.' })
  tokensRouted30d!: number;
}
