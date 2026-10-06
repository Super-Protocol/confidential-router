import { Field, GraphQLISODateTime, ID, InputType, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import type { ExternalEndpointStatus } from '../../../db/entities/external-endpoint.entity.js';
import type { ExternalEndpointEventKind } from '../../../db/entities/external-endpoint-event.entity.js';
import type { ModelCapability } from '../../../db/entities/model.entity.js';
import { ModelCapabilityEnum } from '../catalog/model.model.js';

/** Most models one upstream will ever expose; a list longer than this is a mistake, not a catalogue. */
const MAX_MODELS_PER_ENDPOINT = 50;

/** Micro-USD per 1M tokens, as a decimal string — the `…Micros` rule in `console-graphql.md`. */
const MICROS = /^\d{1,15}$/;

/**
 * The external vocabulary, and it is deliberately not the evidence one.
 *
 * ADR-002's rule — *published / fresh / stale*, never "verified" — is about the
 * router's **own** endpoints, where the router holds no verdict. Toward an external
 * upstream there is a verifying party and it is this router, so these values name
 * it: the console renders them as *verified by this router* / *denied by this
 * router* (ADR-008 §1). The two vocabularies never share a component.
 */
export const ExternalEndpointStatusEnum = {
  PENDING: 'pending',
  VERIFIED_BY_THIS_ROUTER: 'verified',
  DENIED_BY_THIS_ROUTER: 'denied',
  DISABLED: 'disabled',
} as const satisfies Record<string, ExternalEndpointStatus>;

registerEnumType(ExternalEndpointStatusEnum, {
  name: 'ExternalEndpointStatus',
  description:
    'What this router currently says about an upstream. Rendered as “verified by this router” / ' +
    '“denied by this router” — never a bare “verified”, which is reserved for nothing in this schema ' +
    '(ADR-002). PENDING is where every endpoint starts and restarts: no live verdict yet, so it serves nothing.',
});

export const ExternalEndpointEventKindEnum = {
  REGISTERED: 'registered',
  VERIFIED_BY_THIS_ROUTER: 'verified',
  DENIED_BY_THIS_ROUTER: 'denied',
  DIGEST_CHANGED: 'digest_changed',
  MEASUREMENT_CHANGED: 'measurement_changed',
  DISABLED: 'disabled',
  KEY_ROTATED: 'key_rotated',
} as const satisfies Record<string, ExternalEndpointEventKind>;

registerEnumType(ExternalEndpointEventKindEnum, {
  name: 'ExternalEndpointEventKind',
  description:
    'DIGEST_CHANGED and MEASUREMENT_CHANGED fire even while the endpoint stays verified: the same cloud ' +
    'redeploying a different image is exactly what cloud-granularity trust cannot tell you from the status alone.',
});

@ObjectType('ExternalModel', {
  description: 'A model an operator registered on an external endpoint, with the prices every generation freezes.',
})
export class ExternalModelModel {
  @Field(() => ID, { description: 'The public model id, as /v1/models reports it.' })
  id!: string;

  @Field()
  name!: string;

  @Field(() => String, { description: 'What the upstream calls it; the egress leg rewrites `model` to this.' })
  upstreamModel!: string;

  @Field(() => Int)
  contextLength!: number;

  @Field(() => [ModelCapabilityEnum])
  capabilities!: ModelCapability[];

  @Field(() => String, { description: 'Micro-USD per 1M prompt tokens.' })
  promptPer1mMicros!: string;

  @Field(() => String, { description: 'Micro-USD per 1M completion tokens.' })
  completionPer1mMicros!: string;

  @Field(() => String, { description: 'The operator-declared TEE label for this upstream model.' })
  tee!: string;

  @Field(() => Boolean, {
    description: 'False once an operator stopped listing it. The row stays so past generations still resolve.',
  })
  enabled!: boolean;
}

/**
 * An upstream in someone else's deployment, and what this router currently says
 * about it.
 *
 * Readable by any signed-in user, not only operators (ADR-008 §7, ruling 3): an
 * operator curating external capacity in secret is the configuration this product
 * must not be able to sell as confidential. The two fields that are *not* about
 * the upstream — the credential's prefix and who registered it — are the
 * operator's own business and come back null to everyone else.
 *
 * `apiKey` is absent from this type and there is no query that returns it. The
 * plaintext exists in the mutation that seals it and in the egress leg that
 * injects it, and nowhere in between (ADR-008 §6, threat T15).
 */
@ObjectType('ExternalEndpoint', { description: 'A model endpoint in another deployment, attested by this router.' })
export class ExternalEndpointModel {
  @Field(() => ID)
  id!: string;

  @Field(() => String, { description: 'Also the sidecar’s key for this upstream, so it is kebab-case.' })
  name!: string;

  @Field(() => String, { description: 'https://host[:port] — the upstream’s OpenAI-compatible surface.' })
  baseUrl!: string;

  @Field(() => String, { description: 'Derived from baseUrl; what the evidence is fetched from and bound to.' })
  hostname!: string;

  @Field(() => Boolean, { description: 'The operator’s switch. A disabled endpoint is not rendered to the sidecar.' })
  enabled!: boolean;

  @Field(() => ExternalEndpointStatusEnum)
  status!: ExternalEndpointStatus;

  @Field(() => GraphQLISODateTime, { nullable: true, description: 'When the last verdict was read back.' })
  lastCheckedAt!: Date | null;

  @Field(() => String, {
    nullable: true,
    description: 'Stage of the last failure: fetch, cert-chain, untrusted-root, jws, tls-fingerprint, policy.',
  })
  lastStage!: string | null;

  @Field(() => String, { nullable: true })
  lastReason!: string | null;

  @Field(() => String, { nullable: true, description: 'The upstream cloud’s root measurement, as the verdict saw it.' })
  measurementSeen!: string | null;

  @Field(() => String, {
    nullable: true,
    description:
      'Which anchor vouched for the measurement — registry or operator-pinned. Advisory only: for an external ' +
      'endpoint the admin trust list is the sole authority, and a registry signature admits nothing on its own.',
  })
  measurementSource!: string | null;

  @Field(() => String, { nullable: true, description: 'Canonical digest of the upstream deployment snapshot.' })
  evidenceDigestSeen!: string | null;

  @Field(() => String, {
    nullable: true,
    description: 'The TLS leaf the egress pinned. Upstream connections verify against this and no CA bundle.',
  })
  pinnedCertFingerprint!: string | null;

  @Field(() => String, {
    nullable: true,
    description:
      'Leading characters of the stored upstream API key, so an operator can tell which credential this row ' +
      'holds. Null for a non-operator: the key is theirs to manage, not everyone’s to identify.',
  })
  apiKeyPrefix!: string | null;

  @Field(() => String, {
    nullable: true,
    description: 'Email of the operator who registered it. Null for a non-operator.',
  })
  registeredBy!: string | null;

  @Field(() => [ExternalModelModel], { description: 'The registered catalogue, by model id.' })
  models!: ExternalModelModel[];

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}

@ObjectType('ExternalEndpointEvent', {
  description: 'One entry in an endpoint’s verdict timeline. History, never an input to admission.',
})
export class ExternalEndpointEventModel {
  @Field(() => ID)
  id!: string;

  @Field(() => GraphQLISODateTime)
  at!: Date;

  @Field(() => ExternalEndpointEventKindEnum)
  kind!: ExternalEndpointEventKind;

  @Field(() => String, { nullable: true })
  stage!: string | null;

  @Field(() => String, { nullable: true })
  reason!: string | null;

  @Field(() => String, { nullable: true })
  measurement!: string | null;

  @Field(() => String, { nullable: true })
  evidenceDigest!: string | null;
}

@ObjectType('TrustedMeasurement', {
  description:
    'One VM launch measurement this deployment accepts for an external upstream. It admits a *cloud*, never a ' +
    'deployment: any TEE on a listed cloud satisfies it. Removing one denies dependent endpoints on the next check.',
})
export class TrustedMeasurementModel {
  @Field(() => ID)
  id!: string;

  @Field(() => String, { description: '64 lower-case hex characters, normalised on input.' })
  measurement!: string;

  @Field(() => String, { nullable: true, description: 'Why this cloud is trusted, in the operator’s own words.' })
  note!: string | null;

  @Field(() => String, { nullable: true, description: 'Email of the operator who added it. Null for a non-operator.' })
  addedBy!: string | null;

  @Field(() => GraphQLISODateTime)
  addedAt!: Date;
}

@InputType('ExternalModelInput', {
  description: 'A model on an external endpoint, and what this router charges for it.',
})
export class ExternalModelInputModel {
  @Field(() => ID, { description: 'The public model id this router will publish, e.g. partner/llama-3.3-70b:tdx.' })
  @IsString()
  @Length(1, 255)
  id!: string;

  @Field()
  @IsString()
  @Length(1, 255)
  name!: string;

  @Field(() => String, { description: 'The name the upstream knows it by.' })
  @IsString()
  @Length(1, 255)
  upstreamModel!: string;

  @Field(() => Int)
  @IsInt()
  @Min(1)
  @Max(100_000_000)
  contextLength!: number;

  @Field(() => [ModelCapabilityEnum])
  @IsArray()
  @ArrayMinSize(1)
  @IsEnum(ModelCapabilityEnum, { each: true })
  capabilities!: ModelCapability[];

  @Field(() => String, { description: 'Micro-USD per 1M prompt tokens.' })
  @Matches(MICROS)
  promptPer1mMicros!: string;

  @Field(() => String, { description: 'Micro-USD per 1M completion tokens.' })
  @Matches(MICROS)
  completionPer1mMicros!: string;

  @Field(() => String, { description: 'The TEE label to show for this upstream model.' })
  @IsString()
  @Length(1, 128)
  tee!: string;
}

@InputType('RegisterExternalEndpointInput')
export class RegisterExternalEndpointInputModel {
  @Field(() => String, { description: 'Lower-case letters, digits and hyphens; also the sidecar’s key.' })
  @IsString()
  @Length(1, 63)
  name!: string;

  @Field(() => String, { description: 'https://host[:port]. Plain HTTP is refused — there is no channel to pin.' })
  @IsString()
  @Length(1, 2048)
  baseUrl!: string;

  @Field(() => String, {
    description:
      'The upstream’s own LLM API key. Write-only: it is sealed before it reaches a column and no query ' +
      'returns it — only `apiKeyPrefix` comes back.',
  })
  @IsString()
  @IsNotEmpty()
  @Length(1, 512)
  apiKey!: string;

  @Field(() => [ExternalModelInputModel], { description: 'The models to publish, with this router’s prices.' })
  @IsArray()
  @ArrayMaxSize(MAX_MODELS_PER_ENDPOINT)
  @ValidateNested({ each: true })
  @Type(() => ExternalModelInputModel)
  models!: ExternalModelInputModel[];
}

@InputType('UpdateExternalEndpointInput')
export class UpdateExternalEndpointInputModel {
  @Field(() => ID)
  @IsString()
  id!: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @Length(1, 63)
  name?: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @Length(1, 2048)
  baseUrl?: string;

  @Field(() => [ExternalModelInputModel], {
    nullable: true,
    description: 'Replaces the registered set. A model left out is retired, never deleted.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_MODELS_PER_ENDPOINT)
  @ValidateNested({ each: true })
  @Type(() => ExternalModelInputModel)
  models?: ExternalModelInputModel[];
}

@InputType('SetExternalEndpointEnabledInput')
export class SetExternalEndpointEnabledInputModel {
  @Field(() => ID)
  @IsString()
  id!: string;

  @Field(() => Boolean, { description: 'Switching it back on returns it to PENDING: it re-attests from nothing.' })
  @IsBoolean()
  enabled!: boolean;
}

@InputType('RotateExternalEndpointKeyInput')
export class RotateExternalEndpointKeyInputModel {
  @Field(() => ID)
  @IsString()
  id!: string;

  @Field(() => String, { description: 'The replacement upstream key. Rotation is a write; there is nothing to read.' })
  @IsString()
  @IsNotEmpty()
  @Length(1, 512)
  apiKey!: string;
}

@InputType('AddTrustedMeasurementInput')
export class AddTrustedMeasurementInputModel {
  @Field(() => String, {
    description: '64 hex characters, with or without a `sha256:` / `0x` prefix and in either case — it is normalised.',
  })
  @IsString()
  @Length(1, 128)
  measurement!: string;

  @Field(() => String, { nullable: true, description: 'Why this cloud is trusted. Shown beside the entry.' })
  @IsOptional()
  @IsString()
  @Length(0, 255)
  note?: string;
}

@InputType('UpdateTrustedMeasurementInput')
export class UpdateTrustedMeasurementInputModel {
  @Field(() => ID)
  @IsString()
  id!: string;

  @Field(() => String, { nullable: true, description: 'Null or blank clears the note. The measurement is immutable.' })
  @IsOptional()
  @IsString()
  @Length(0, 255)
  note?: string;
}
