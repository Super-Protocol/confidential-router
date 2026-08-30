import { Field, ID, Int, ObjectType } from '@nestjs/graphql';
import type { EvidenceState } from '../../../evidence/index.js';
import { EvidenceSnapshotModel, EvidenceStateEnum } from './evidence.model.js';

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
