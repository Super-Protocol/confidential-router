import { Field, GraphQLISODateTime, ID, ObjectType } from '@nestjs/graphql';
import type { ExternalEndpointStatus } from '../../../db/entities/external-endpoint.entity.js';
import { ExternalEndpointStatusEnum } from '../external-endpoints/external-endpoint-status.enum.js';

/**
 * The upstream behind an external model, as the catalogue shows it.
 *
 * ## Why not `ExternalEndpoint`
 *
 * The admin section's type carries the base URL, the stored key's prefix and the
 * name the upstream knows each model by. This one carries a hostname, a status and
 * the two values the last verdict saw — because the catalogue is the one surface
 * that is also readable without a session, and ruling 3 on SUP-221 is explicit
 * about where that line runs: the anonymous `models` query exposes **no endpoint
 * URLs and no verdict detail**. A reduced type is how that is enforced by the
 * schema rather than by remembering which fields to null out.
 *
 * `Model.externalUpstream` is therefore null for an anonymous caller — all of it,
 * not field by field: "there is an upstream and here is nothing about it" is not a
 * statement worth making, and `Model.origin` already says the model is external.
 *
 * ## It is not a verdict about a channel the reader uses
 *
 * `status` is this router's verdict about the router→upstream channel, which the
 * router's egress pins. It says nothing about the browser's own connection — that
 * one terminates at this router, and is what the chat's tier-1 gate checks. The
 * console never renders the two in one component (ADR-008 §1).
 */
@ObjectType('ExternalUpstream', {
  description:
    'The deployment behind an external model, and where this router’s verification of it stands. Readable by ' +
    'any signed-in user; absent entirely for an anonymous caller (SUP-221 ruling 3).',
})
export class ExternalUpstreamModel {
  @Field(() => ID)
  id!: string;

  @Field(() => String, {
    description:
      'The endpoint name. Also the key of this router’s raw-bundle relay, `GET /v1/evidence/{endpoint}`, which ' +
      'is how a browser reads the upstream’s published evidence and verifies it itself.',
  })
  name!: string;

  @Field(() => String, { description: 'The upstream’s own hostname — what its evidence is bound to.' })
  hostname!: string;

  @Field(() => ExternalEndpointStatusEnum, {
    description: 'Rendered as “verified by this router” / “denied by this router”, never a bare “verified”.',
  })
  status!: ExternalEndpointStatus;

  @Field(() => GraphQLISODateTime, { nullable: true, description: 'When the last verdict was read back.' })
  lastCheckedAt!: Date | null;

  @Field(() => String, { nullable: true, description: 'The upstream cloud’s root measurement, as the verdict saw it.' })
  measurementSeen!: string | null;

  @Field(() => String, {
    nullable: true,
    description: 'Canonical digest of the upstream deployment snapshot the verdict admitted.',
  })
  evidenceDigestSeen!: string | null;

  @Field(() => String, {
    nullable: true,
    description:
      'evidenceDigestSeen as 64 hex characters — the spelling every screen shows and copies (SUP-115). Null when ' +
      'there is no digest, or when the stored value is not one the parser accepts.',
  })
  evidenceDigestSeenHex!: string | null;
}
