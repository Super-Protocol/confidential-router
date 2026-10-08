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
import { MeasurementModel } from '../catalog/evidence.model.js';
import { ModelCapabilityEnum, PricingModel } from '../catalog/model.model.js';
import { ExternalEndpointStatusEnum } from './external-endpoint-status.enum.js';

export { ExternalEndpointStatusEnum } from './external-endpoint-status.enum.js';

/** Most models one upstream will ever expose; a list longer than this is a mistake, not a catalogue. */
const MAX_MODELS_PER_ENDPOINT = 50;

/** Micro-USD per 1M tokens, as a decimal string — the `…Micros` rule in `console-graphql.md`. */
const MICROS = /^\d{1,15}$/;

export const ExternalEndpointEventKindEnum = {
  REGISTERED: 'registered',
  VERIFIED_BY_THIS_ROUTER: 'verified',
  DENIED_BY_THIS_ROUTER: 'denied',
  DIGEST_CHANGED: 'digest_changed',
  DIGEST_PINNED: 'digest_pinned',
  MEASUREMENT_CHANGED: 'measurement_changed',
  DISABLED: 'disabled',
  KEY_ROTATED: 'key_rotated',
} as const satisfies Record<string, ExternalEndpointEventKind>;

registerEnumType(ExternalEndpointEventKindEnum, {
  name: 'ExternalEndpointEventKind',
  description:
    'DIGEST_CHANGED and MEASUREMENT_CHANGED are reported on every change. Under two-factor trust a ' +
    'DIGEST_CHANGED is gating: the pinned digest no longer matches, so on an admitted endpoint it arrives ' +
    'with the DENIED_BY_THIS_ROUTER it caused. DIGEST_PINNED is an admin approving a deployment, and carries the digest.',
});

/**
 * Which anchor vouched for the measurement a verdict saw (SUP-139).
 *
 * An enum rather than the string the column holds, because this is a value a
 * third-party consumer branches on and the contract rule is that such a value
 * lives at the type level (ADR-008 §1). Advisory either way: for an external
 * endpoint the admin trust list is the sole authority on admission, and a
 * registry signature admits nothing on its own.
 */
export const MeasurementSourceEnum = {
  REGISTRY: 'registry',
  OPERATOR_PINNED: 'operator-pinned',
} as const satisfies Record<string, string>;

registerEnumType(MeasurementSourceEnum, {
  name: 'MeasurementSource',
  description: 'Which anchor vouched for the measurement the verdict saw (SUP-139).',
});

/** The column values the enum above spells; anything else is reported as "not stated". */
const MEASUREMENT_SOURCES = new Set<string>(Object.values(MeasurementSourceEnum));

/**
 * Narrows the stored string onto the enum.
 *
 * A value the enum does not know is reported as null rather than crashing the
 * field: the string comes from the sidecar's report, which is a seam this
 * repository versions separately, and a gatekeeper that grows a third anchor
 * should make the console say "not stated" rather than make the admin screen
 * fail to load.
 */
export function measurementSourceOf(value: string | null): string | null {
  return value && MEASUREMENT_SOURCES.has(value) ? value : null;
}

@ObjectType('EvidenceWorkload', { description: 'One Kubernetes workload of the upstream’s canonical snapshot.' })
export class EvidenceWorkloadModel {
  @Field(() => String, { description: 'Deployment, StatefulSet, Pod… — as the snapshot spells it.' })
  kind!: string;

  @Field()
  name!: string;

  @Field(() => String, { nullable: true, description: 'Absent on a cluster-scoped resource.' })
  namespace!: string | null;

  @Field(() => [String], { description: 'Container names, init containers included.' })
  containers!: string[];
}

/**
 * What a cloud-level admission actually let in: the upstream's workloads and
 * image digests.
 *
 * **Informational, never gating** (SUP-221 ruling 1). Admission is the
 * measurement check in ADR-008 §3 and nothing here — that check admits a *cloud*
 * and cannot see which deployment on it answered (threat T13), which is precisely
 * why the console renders this for every registered endpoint and on every change.
 * A reader who took it for an approval would be reading per-endpoint approval back
 * into a design that removed it.
 */
@ObjectType('ExternalEndpointEvidence', {
  description:
    'The upstream’s published bundle, summarised. Informational, never gating — admission is the measurement ' +
    'check in ADR-008 §3 and nothing in here.',
})
export class ExternalEndpointEvidenceModel {
  @Field(() => ID, { description: 'The `evidence_snapshots` row this summary is of.' })
  snapshotId!: string;

  @Field(() => GraphQLISODateTime, { description: 'When this router last retrieved this publication.' })
  fetchedAt!: Date;

  @Field(() => GraphQLISODateTime, { description: 'When the upstream’s platform signed it.' })
  issuedAt!: Date;

  @Field(() => String, { description: 'sha256/<base64url> of the upstream’s canonical deployment snapshot.' })
  evidenceDigest!: string;

  @Field(() => String, { description: 'The same digest in hex, which is what the console renders.' })
  evidenceDigestHex!: string;

  @Field(() => String, { description: 'sha256/<base64url> of the TLS leaf the bundle asserts.' })
  certFingerprint!: string;

  @Field(() => String, { description: 'The same fingerprint in hex.' })
  certFingerprintHex!: string;

  @Field(() => String, { nullable: true, description: 'rootCaTeeQuote.format, e.g. intel-tdx-quote-v5.' })
  quoteFormat!: string | null;

  @Field(() => [String], { description: 'Enclave image digests from the upstream’s canonical snapshot.' })
  containerImages!: string[];

  @Field(() => [EvidenceWorkloadModel], { description: 'Empty when the snapshot declares none this router can read.' })
  workloads!: EvidenceWorkloadModel[];

  @Field(() => [MeasurementModel], { description: 'Empty when the producer published none.' })
  measurements!: MeasurementModel[];
}

/**
 * A model registered on an external endpoint.
 *
 * The GraphQL type is `ExternalEndpointModel` — the contract's name, and the one
 * that cannot be misread as "a model that happens to be external" — while the
 * class keeps its shorter name so it does not read as `ExternalEndpointModelModel`.
 */
@ObjectType('ExternalEndpointModel', {
  description: 'A model an operator registered on an external endpoint, with the prices every generation freezes.',
})
export class ExternalModelModel {
  @Field(() => ID, { description: 'The public model id, as /v1/models reports it.' })
  id!: string;

  @Field()
  name!: string;

  @Field(() => String, {
    nullable: true,
    description:
      'The name the upstream knows it by; the egress leg rewrites `model` to this. Operator only — null for ' +
      'everyone else, because it is a fact about another operator’s deployment rather than about this catalogue.',
  })
  upstreamModel!: string | null;

  @Field(() => Int)
  contextLength!: number;

  @Field(() => PricingModel, { description: 'What this router charges for it, in micro-USD per 1M tokens.' })
  pricing!: PricingModel;

  @Field(() => [ModelCapabilityEnum])
  capabilities!: ModelCapability[];
}

/**
 * An upstream in someone else's deployment, and what this router currently says
 * about it.
 *
 * Readable by any signed-in user, not only operators (ADR-008 §7, ruling 3): an
 * operator curating external capacity in secret is the configuration this product
 * must not be able to sell as confidential. The two fields that are *not* facts
 * about the upstream's own deployment — the stored credential's prefix and the
 * name the upstream knows each model by — come back null to everyone else.
 *
 * `apiKey` is absent from this type and there is no query that returns it. The
 * plaintext exists in the mutation that seals it and in the egress leg that
 * injects it, and nowhere in between (ADR-008 §6, threat T15).
 */
@ObjectType('ExternalEndpoint', { description: 'A model endpoint in another deployment, attested by this router.' })
export class ExternalEndpointModel {
  @Field(() => ID)
  id!: string;

  @Field(() => String, {
    description: 'Immutable after registration: it is also the sidecar’s key for this upstream, so it is kebab-case.',
  })
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
    description:
      'Where the last check stopped: a pipeline stage (fetch, cert-chain, untrusted-root, jws, tls-fingerprint, ' +
      'policy) or the trust factor refused — digest-not-pinned (PENDING: nothing approved yet), ' +
      'measurement-not-trusted, or digest-mismatch (a redeploy nobody approved).',
  })
  lastStage!: string | null;

  @Field(() => String, { nullable: true })
  lastReason!: string | null;

  @Field(() => String, { nullable: true, description: 'The upstream cloud’s root measurement, as the verdict saw it.' })
  measurementSeen!: string | null;

  @Field(() => MeasurementSourceEnum, {
    nullable: true,
    description:
      'Which anchor vouched for the measurement — registry or operator-pinned. Advisory only: for an external ' +
      'endpoint the admin trust list is the sole authority, and a registry signature admits nothing on its own.',
  })
  measurementSource!: string | null;

  @Field(() => Boolean, {
    nullable: true,
    description:
      'Whether the sidecar found the measurement it saw signed in the Super Protocol registry, reported on a ' +
      'denial too. Informational only: it never admits — the admin trust list is the sole authority. Null when ' +
      'no measurement was derived.',
  })
  measurementInRegistry!: boolean | null;

  @Field(() => String, { nullable: true, description: 'Canonical digest of the upstream deployment snapshot.' })
  evidenceDigestSeen!: string | null;

  @Field(() => String, {
    nullable: true,
    description: 'evidenceDigestSeen as 64 hex characters — the spelling every screen shows and copies (SUP-115).',
  })
  evidenceDigestSeenHex!: string | null;

  @Field(() => String, {
    nullable: true,
    description:
      'The deployment an admin approved — the second trust factor beside the cloud measurement. Admission requires ' +
      'evidenceDigestSeen to equal it. Null: nothing approved yet, so the endpoint stays PENDING. Readable by any ' +
      'signed-in user, like the trust list.',
  })
  pinnedEvidenceDigest!: string | null;

  @Field(() => String, { nullable: true, description: 'pinnedEvidenceDigest as 64 hex characters.' })
  pinnedEvidenceDigestHex!: string | null;

  @Field(() => ExternalEndpointEvidenceModel, {
    nullable: true,
    description:
      'The evidence summary behind pinnedEvidenceDigest, when this router filed it — what "approve new digest" ' +
      'compares the current publication against.',
  })
  pinnedEvidence!: ExternalEndpointEvidenceModel | null;

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

  @Field(() => [ExternalModelModel], {
    description: 'The models the operator currently lists, by model id. A retired one is no longer registered.',
  })
  models!: ExternalModelModel[];

  @Field(() => [ExternalEndpointEventModel], { description: 'The verdict and status timeline, most recent first.' })
  events!: ExternalEndpointEventModel[];

  @Field(() => ExternalEndpointEvidenceModel, {
    nullable: true,
    description:
      'What the upstream publishes right now, as the last verdict saw it. Null until a verdict has verified the ' +
      'evidence — admitted, or refused only by a trust factor — and this router has retrieved the publication that ' +
      'verdict names.',
  })
  latestEvidence!: ExternalEndpointEvidenceModel | null;

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

  @Field(() => String, {
    nullable: true,
    description:
      'ADR-003 §1 pipeline stage of a refusal: fetch, cert-chain, untrusted-root, jws, tls-fingerprint, policy.',
  })
  stage!: string | null;

  @Field(() => String, { nullable: true })
  reason!: string | null;

  @Field(() => String, { nullable: true })
  measurement!: string | null;

  @Field(() => String, { nullable: true })
  evidenceDigest!: string | null;

  @Field(() => ExternalEndpointEvidenceModel, {
    nullable: true,
    description:
      'The evidence summary in force at this event, so ruling 1’s “at registration and on every change” is what ' +
      'the timeline renders rather than a convention. Null when no snapshot was stored for it — an entry that ' +
      'names no digest, or one whose publication this router never managed to retrieve.',
  })
  evidence!: ExternalEndpointEvidenceModel | null;
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
  addedByEmail!: string | null;

  @Field(() => GraphQLISODateTime)
  addedAt!: Date;

  @Field(() => Int, {
    description:
      'Registered endpoints this row currently admits — what removing it would drop. Computed from the ' +
      'measurement each endpoint’s last verdict saw, so it is a statement about the last check and not a ' +
      'promise about the next one.',
  })
  admits!: number;
}

@ObjectType('DiscoveredExternalModel', {
  description:
    'One model an attested upstream lists on its own GET /v1/models (SUP-249). Hints only — the operator ' +
    'chooses the public id, the name and the prices when registering it.',
})
export class DiscoveredExternalModelModel {
  @Field(() => String, { description: 'The upstream’s id for it: what ExternalModelInput.upstreamModel takes.' })
  upstreamModel!: string;

  @Field(() => String, { nullable: true })
  name!: string | null;

  @Field(() => Int, { nullable: true })
  contextLength!: number | null;

  @Field(() => String, {
    nullable: true,
    description: 'Micro-USD per 1M prompt tokens, when the upstream publishes a price (another router does).',
  })
  promptPer1mMicros!: string | null;

  @Field(() => String, { nullable: true, description: 'Micro-USD per 1M completion tokens, likewise.' })
  completionPer1mMicros!: string | null;

  @Field(() => String, {
    nullable: true,
    description: 'The public model id this endpoint already publishes it under, or null.',
  })
  registeredAs!: string | null;
}

@InputType('ExternalModelInput', {
  description: 'A model on an external endpoint, and what this router charges for it.',
})
export class ExternalModelInputModel {
  @Field(() => String, {
    description:
      'The public model id this router will publish, e.g. partner/llama-3.3-70b:tdx. A `String`, not an `ID`: ' +
      'it is a name the operator chooses here rather than a handle to something that already exists.',
  })
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

  @Field(() => [ModelCapabilityEnum], {
    nullable: true,
    description: 'Defaults to CHAT — the one capability every OpenAI-compatible upstream serves.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @IsEnum(ModelCapabilityEnum, { each: true })
  capabilities?: ModelCapability[];

  @Field(() => String, { description: 'Micro-USD per 1M prompt tokens.' })
  @Matches(MICROS)
  promptPer1mMicros!: string;

  @Field(() => String, { description: 'Micro-USD per 1M completion tokens.' })
  @Matches(MICROS)
  completionPer1mMicros!: string;
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

/**
 * `name` is absent on purpose — see {@link ExternalEndpointModel.name}. So is
 * `id`: it names which endpoint is being changed rather than what about it, so it
 * is an argument of the mutation and not a member of its payload (the contract's
 * `updateExternalEndpoint(id: ID!, input: …)`).
 */
@InputType('UpdateExternalEndpointInput')
export class UpdateExternalEndpointInputModel {
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
  @Field(() => Boolean, { description: 'Switching it back on returns it to PENDING: it re-attests from nothing.' })
  @IsBoolean()
  enabled!: boolean;
}

@InputType('RotateExternalEndpointKeyInput')
export class RotateExternalEndpointKeyInputModel {
  @Field(() => String, { description: 'The replacement upstream key. Rotation is a write; there is nothing to read.' })
  @IsString()
  @IsNotEmpty()
  @Length(1, 512)
  apiKey!: string;
}

@InputType('PinExternalEndpointDigestInput')
export class PinExternalEndpointDigestInputModel {
  @Field(() => String, {
    description:
      'The deployment to approve: sha256:<64 hex> (what the console shows) or sha256/<base64url>. Normalised. ' +
      'Replaces any earlier pin.',
  })
  @IsString()
  @Length(1, 128)
  evidenceDigest!: string;
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
