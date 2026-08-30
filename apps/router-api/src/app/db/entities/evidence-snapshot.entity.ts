import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn, type Relation } from 'typeorm';
import { idColumn, idPrimaryColumn, jsonColumn, timestampColumn } from '../columns.js';
import { Endpoint } from './endpoint.entity.js';

export interface CertificateSummary {
  subject: string;
  issuer: string;
  notAfter: string;
  fingerprint: string;
}

/**
 * What an endpoint *published*, and when. Never whether it was any good.
 *
 * The one architectural rule of this product (parent issue, ADR-002): the router
 * does not know when, whether or by whom it is attested. Verification happens in
 * the user's Gatekeeper. Accordingly this table has no boolean about validity,
 * no verdict, no verifier identity — adding one would be a design regression,
 * and `evidence-snapshot.entity.spec.ts` fails the build if one appears.
 */
@Entity({ name: 'evidence_snapshots' })
@Index('IDX_evidence_snapshots_identity', ['endpointId', 'evidenceDigest', 'certFingerprint', 'issuedAt'], {
  unique: true,
})
export class EvidenceSnapshot {
  @PrimaryColumn(idPrimaryColumn())
  id!: string;

  @Index('IDX_evidence_snapshots_endpointId')
  @Column(idColumn())
  endpointId!: string;

  @Column(timestampColumn())
  fetchedAt!: Date;

  @Column(timestampColumn())
  issuedAt!: Date;

  /** Canonical `sha256/<base64url>` form. */
  @Column({ type: 'varchar', length: 128 })
  evidenceDigest!: string;

  @Column({ type: 'varchar', length: 64 })
  evidenceDigestHex!: string;

  /** `sha256/<base64url>` of the TLS leaf DER the bundle asserts. */
  @Column({ type: 'varchar', length: 128 })
  certFingerprint!: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  quoteFormat!: string | null;

  @Column(jsonColumn())
  containerImages!: string[];

  @Column(jsonColumn())
  chainSummary!: CertificateSummary[];

  @Column(jsonColumn({ nullable: true }))
  measurements!: Record<string, unknown> | null;

  /** Compact JWS as published. Subject to `UserPreferences.evidenceRetentionDays`. */
  @Column({ type: 'text' })
  jws!: string;

  /** Raw bundle as published. Subject to `UserPreferences.evidenceRetentionDays`. */
  @Column(jsonColumn())
  bundle!: Record<string, unknown>;

  @ManyToOne(
    () => Endpoint,
    (endpoint) => endpoint.evidenceSnapshots,
    { onDelete: 'CASCADE' },
  )
  @JoinColumn({ name: 'endpointId' })
  endpoint?: Relation<Endpoint>;
}
