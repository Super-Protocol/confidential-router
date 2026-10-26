import { ArgsType, Field, Float, ID, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import { IsDate, IsOptional, IsString } from 'class-validator';
import type { EvidenceSnapshot } from '../../../db/entities/evidence-snapshot.entity.js';
import type { Coverage, DigestChange } from '../../../evidence/index.js';
import { type EvidenceState, fingerprintHex, quoteAgeMs, teeLabelOfBundle } from '../../../evidence/index.js';
import { PageInfoModel } from '../common/page-info.model.js';
import { JSONObject } from '../scalars/json.scalar.js';

/** Runtime twin of the `EvidenceState` union, because GraphQL needs a value to register. */
export const EvidenceStateEnum = {
  PUBLISHED: 'PUBLISHED',
  STALE: 'STALE',
  NOT_PUBLISHED: 'NOT_PUBLISHED',
} as const satisfies Record<EvidenceState, EvidenceState>;

registerEnumType(EvidenceStateEnum, {
  name: 'EvidenceState',
  description:
    'Whether the platform currently publishes a bundle for this endpoint, and whether it is inside the ' +
    'freshness window. A statement about publication only — the router never reports a verification verdict.',
});

@ObjectType('CertSummary', { description: 'One certificate of the published chain, leaf → root.' })
export class CertSummaryModel {
  @Field()
  subject!: string;

  @Field()
  issuer!: string;

  @Field()
  notAfter!: string;

  @Field(() => String, { description: 'sha256/<base64url> of the certificate DER — the form the bundle carries.' })
  fingerprint!: string;

  @Field(() => String, {
    description: 'The same fingerprint in hex, which is how the console and the gatekeeper show it.',
  })
  fingerprintHex!: string;

  @Field(() => Boolean, { description: 'True for the terminal certificate of the published chain.' })
  isRoot!: boolean;
}

@ObjectType('Measurement', { description: 'A measurement register the producer published (MRTD, RTMR0-2, GPU…).' })
export class MeasurementModel {
  @Field()
  name!: string;

  @Field()
  value!: string;
}

@ObjectType('EvidenceSnapshot', { description: 'What an endpoint published, and when. Never whether it was valid.' })
export class EvidenceSnapshotModel {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  endpointId!: string;

  @Field(() => Date, { description: 'When this router last retrieved this publication.' })
  fetchedAt!: Date;

  @Field(() => Date, { description: 'When the platform signed it.' })
  issuedAt!: Date;

  @Field(() => Int, { description: 'Quote age in seconds — "issued 4 min ago" in the evidence modal.' })
  quoteAgeSeconds!: number;

  @Field(() => String, {
    description: 'sha256/<base64url> of the canonical deployment snapshot — the value users pin.',
  })
  evidenceDigest!: string;

  @Field(() => String, { description: 'The same digest in hex, for tools that expect that form.' })
  evidenceDigestHex!: string;

  @Field(() => String, { description: 'sha256/<base64url> of the TLS leaf the bundle asserts.' })
  certFingerprint!: string;

  @Field(() => String, { description: 'The same fingerprint in hex, which is what the console renders.' })
  certFingerprintHex!: string;

  @Field(() => String, { nullable: true, description: 'rootCaTeeQuote.format, e.g. intel-tdx-quote-v5.' })
  quoteFormat!: string | null;

  @Field(() => String, {
    nullable: true,
    description:
      'The TEE the published evidence names — the hardware branch of the TeeEvidence in the root ' +
      'certificate of the chain, e.g. "AMD SEV-SNP (Azure)". Read, never verified; null when the root ' +
      'carries no evidence this router recognises.',
  })
  tee!: string | null;

  @Field(() => [String], { description: 'Enclave image digests from the canonical snapshot.' })
  containerImages!: string[];

  @Field(() => [CertSummaryModel])
  chain!: CertSummaryModel[];

  @Field(() => [MeasurementModel], { description: 'Empty when the producer published none.' })
  measurements!: MeasurementModel[];

  @Field(() => String, {
    nullable: true,
    description:
      'The compact JWS as published — "Copy evidence JWS". Null once the retention sweep has removed the ' +
      'document: the `evidenceSnapshots` connection reaches an endpoint’s whole history, and a publication ' +
      'past the retention window of every account that held it keeps its digests and nothing else.',
  })
  jws!: string | null;

  @Field(() => JSONObject, {
    nullable: true,
    description: 'The raw bundle, for export and offline verification. Null once the retention sweep has removed it.',
  })
  bundle!: Record<string, unknown> | null;

  @Field(() => Date, {
    nullable: true,
    description: 'When the retention sweep removed `jws` and `bundle`, or null while this row still carries them.',
  })
  payloadStrippedAt!: Date | null;

  static from(snapshot: EvidenceSnapshot, now: Date = new Date()): EvidenceSnapshotModel {
    return {
      id: snapshot.id,
      endpointId: ownEndpointIdOf(snapshot),
      fetchedAt: snapshot.fetchedAt,
      issuedAt: snapshot.issuedAt,
      quoteAgeSeconds: Math.round(quoteAgeMs(snapshot, now) / 1000),
      evidenceDigest: snapshot.evidenceDigest,
      evidenceDigestHex: snapshot.evidenceDigestHex,
      certFingerprint: snapshot.certFingerprint,
      // Derived rather than stored: it is a second spelling of a column the row
      // already has, and one the console asks for on every screen that shows a
      // fingerprint (SUP-115).
      certFingerprintHex: fingerprintHex(snapshot.certFingerprint),
      quoteFormat: snapshot.quoteFormat,
      // Derived from the stored bundle rather than a column, like the hex
      // spellings above: the root certificate is already in the row (SUP-270) —
      // until the retention sweep takes the bundle, after which the row knows
      // the digests and no longer the hardware (SUP-498).
      tee: snapshot.bundle ? teeLabelOfBundle(snapshot.bundle) : null,
      containerImages: snapshot.containerImages,
      chain: snapshot.chainSummary.map((certificate, index) => ({
        ...certificate,
        fingerprintHex: fingerprintHex(certificate.fingerprint),
        isRoot: index === snapshot.chainSummary.length - 1,
      })),
      measurements: Object.entries(snapshot.measurements ?? {}).map(([name, value]) => ({
        name,
        value: typeof value === 'string' ? value : JSON.stringify(value),
      })),
      jws: snapshot.jws,
      bundle: snapshot.bundle,
      payloadStrippedAt: snapshot.payloadStrippedAt,
    };
  }
}

/**
 * The publishing endpoint of a snapshot this type is built from.
 *
 * `endpointId` is nullable on the row since ADR-008 §6 — an external upstream's
 * publication has no `endpoints` row — but every query that reaches this model is
 * scoped to one of *our* endpoints, so a null here is a query that has started
 * picking up another operator's bundles. That is worth failing on rather than
 * rendering as a blank id on a screen about this deployment.
 */
function ownEndpointIdOf(snapshot: EvidenceSnapshot): string {
  if (!snapshot.endpointId) {
    throw new Error(
      `Evidence snapshot ${snapshot.id} was published by an external upstream and has no endpoint of ours.`,
    );
  }
  return snapshot.endpointId;
}

@ObjectType('EvidenceSnapshotEdge')
export class EvidenceSnapshotEdgeModel {
  @Field()
  cursor!: string;

  @Field(() => EvidenceSnapshotModel)
  node!: EvidenceSnapshotModel;
}

@ObjectType('EvidenceSnapshotConnection')
export class EvidenceSnapshotConnectionModel {
  @Field(() => [EvidenceSnapshotEdgeModel])
  edges!: EvidenceSnapshotEdgeModel[];

  @Field(() => PageInfoModel)
  pageInfo!: PageInfoModel;
}

@ObjectType('EvidenceDigestChange', {
  description: 'One distinct digest an endpoint has published, and the period it was current for.',
})
export class DigestChangeModel {
  @Field(() => String)
  evidenceDigest!: string;

  @Field(() => String)
  evidenceDigestHex!: string;

  @Field(() => Date, { description: 'issuedAt of the first bundle carrying this digest.' })
  firstIssuedAt!: Date;

  @Field(() => Date, { description: 'issuedAt of the last one.' })
  lastIssuedAt!: Date;

  @Field(() => Int, { description: 'How many publications carried it.' })
  snapshots!: number;

  static from(change: DigestChange): DigestChangeModel {
    return change;
  }
}

@ObjectType('EvidenceCoverage', {
  description:
    'Of the generations this deployment’s own endpoints served in a window, how many were served while ' +
    'the platform had a fresh bundle published for the endpoint that served them. A fact about ' +
    'publication, not a verification rate. Generations routed to an external endpoint are outside the ' +
    'question entirely — they are in neither `requests` nor `covered` — because this platform publishes ' +
    'no bundle for one; the router verified that upstream itself and reports it as “verified by this ' +
    'router” (ADR-008 §4).',
})
export class EvidenceCoverageModel {
  @Field(() => Int, { description: 'Generations this deployment’s own endpoints served — not the workspace’s total.' })
  requests!: number;

  @Field(() => Int)
  covered!: number;

  @Field(() => Float, {
    nullable: true,
    description:
      'covered / requests. Null when `requests` is 0: nothing in the window could have been covered, so ' +
      'there is no ratio — render it as “not applicable”, never as 0%.',
  })
  ratio!: number | null;

  static from(coverage: Coverage): EvidenceCoverageModel {
    return coverage;
  }
}

/**
 * Arguments of the `evidenceCoverage` query, as a class so the resolver stays
 * within the parameter budget. The `class-validator` decorators are what the
 * application's global `ValidationPipe` whitelists on — an args class without
 * them is rejected wholesale.
 */
@ArgsType()
export class EvidenceCoverageArgs {
  @Field(() => ID)
  @IsString()
  workspaceId!: string;

  @Field(() => Date)
  @IsDate()
  from!: Date;

  @Field(() => Date)
  @IsDate()
  to!: Date;

  @Field(() => ID, { nullable: true, description: 'Narrow to the generations one endpoint served.' })
  @IsOptional()
  @IsString()
  endpointId?: string;
}
