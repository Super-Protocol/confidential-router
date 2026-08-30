import { ArgsType, Field, Float, ID, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import { IsDate, IsOptional, IsString } from 'class-validator';
import type { EvidenceSnapshot } from '../../../db/entities/evidence-snapshot.entity.js';
import type { Coverage, DigestChange } from '../../../evidence/index.js';
import { type EvidenceState, quoteAgeMs } from '../../../evidence/index.js';
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

  @Field(() => String, { description: 'sha256/<base64url> of the certificate DER.' })
  fingerprint!: string;

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

  @Field(() => String, { nullable: true, description: 'rootCaTeeQuote.format, e.g. intel-tdx-quote-v5.' })
  quoteFormat!: string | null;

  @Field(() => [String], { description: 'Enclave image digests from the canonical snapshot.' })
  containerImages!: string[];

  @Field(() => [CertSummaryModel])
  chain!: CertSummaryModel[];

  @Field(() => [MeasurementModel], { description: 'Empty when the producer published none.' })
  measurements!: MeasurementModel[];

  @Field(() => String, { description: 'The compact JWS as published — "Copy evidence JWS".' })
  jws!: string;

  @Field(() => JSONObject, { description: 'The raw bundle, for export and offline verification.' })
  bundle!: Record<string, unknown>;

  static from(snapshot: EvidenceSnapshot, now: Date = new Date()): EvidenceSnapshotModel {
    return {
      id: snapshot.id,
      endpointId: snapshot.endpointId,
      fetchedAt: snapshot.fetchedAt,
      issuedAt: snapshot.issuedAt,
      quoteAgeSeconds: Math.round(quoteAgeMs(snapshot, now) / 1000),
      evidenceDigest: snapshot.evidenceDigest,
      evidenceDigestHex: snapshot.evidenceDigestHex,
      certFingerprint: snapshot.certFingerprint,
      quoteFormat: snapshot.quoteFormat,
      containerImages: snapshot.containerImages,
      chain: snapshot.chainSummary.map((certificate, index) => ({
        ...certificate,
        isRoot: index === snapshot.chainSummary.length - 1,
      })),
      measurements: Object.entries(snapshot.measurements ?? {}).map(([name, value]) => ({
        name,
        value: typeof value === 'string' ? value : JSON.stringify(value),
      })),
      jws: snapshot.jws,
      bundle: snapshot.bundle,
    };
  }
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
    'Of the generations served in a window, how many were served while the platform had a fresh bundle ' +
    'published for the endpoint that served them. A fact about publication, not a verification rate.',
})
export class EvidenceCoverageModel {
  @Field(() => Int)
  requests!: number;

  @Field(() => Int)
  covered!: number;

  @Field(() => Float, { description: 'covered / requests; 0 when nothing was served.' })
  ratio!: number;

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
