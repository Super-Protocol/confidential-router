import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn, type Relation } from 'typeorm';
import { idColumn, idPrimaryColumn, jsonColumn, timestampColumn } from '../columns.js';
import { Endpoint } from './endpoint.entity.js';
import { ExternalEndpoint } from './external-endpoint.entity.js';

export interface CertificateSummary {
  subject: string;
  issuer: string;
  notAfter: string;
  fingerprint: string;
}

/**
 * One Kubernetes workload named in the canonical deployment snapshot, reduced to
 * what a reader compares.
 *
 * Stored beside {@link EvidenceSnapshot.containerImages} rather than derived on
 * read for the same reason that list is: the bundle is parsed once, on the way
 * in, and every surface reads columns instead of re-walking a producer-shaped
 * document. The admin section's evidence summary is the first reader (ADR-008
 * §7, SUP-221 ruling 1).
 */
export interface EvidenceWorkloadSummary {
  /** `Deployment`, `StatefulSet`, `Pod`… — the resource kind as the snapshot spells it. */
  kind: string;
  name: string;
  /** Absent on a cluster-scoped resource, and on a producer that publishes none. */
  namespace: string | null;
  /** Container names, init containers included. */
  containers: string[];
}

/**
 * What an endpoint *published*, and when. Never whether it was any good.
 *
 * The one architectural rule of this product (parent issue, ADR-002): the router
 * does not know when, whether or by whom it is attested. Verification happens in
 * the user's Gatekeeper. Accordingly this table has no boolean about validity,
 * no verdict, no verifier identity — adding one would be a design regression,
 * and `evidence-snapshot.entity.spec.ts` fails the build if one appears.
 *
 * That holds for an external upstream's bundle too (ADR-008 §6): the verdict
 * about it lives on {@link ExternalEndpoint}, which is re-derived live, and what
 * is filed here is still only what the upstream published. Storing it is what
 * lets the console relay the raw bundle for a user's own in-browser check.
 */
@Entity({ name: 'evidence_snapshots' })
@Index('IDX_evidence_snapshots_identity', ['endpointId', 'evidenceDigest', 'certFingerprint', 'issuedAt'], {
  unique: true,
})
@Index(
  'IDX_evidence_snapshots_external_identity',
  ['externalEndpointId', 'evidenceDigest', 'certFingerprint', 'issuedAt'],
  { unique: true },
)
export class EvidenceSnapshot {
  @PrimaryColumn(idPrimaryColumn())
  id!: string;

  /**
   * The router's own endpoint that published this bundle, or null when an
   * external upstream did.
   *
   * Exactly one of this and {@link externalEndpointId} is set, which is
   * {@link evidenceSnapshotEndpointIsExclusive} — the same XOR
   * `generations.endpointId` carries, for the same reason: `endpoints` and
   * `external_endpoints` are separate namespaces, and every query that groups by
   * this column is asking about hosts *this* router publishes evidence for.
   */
  @Index('IDX_evidence_snapshots_endpointId')
  @Column(idColumn({ nullable: true }))
  endpointId!: string | null;

  /**
   * The external upstream this bundle was published by, or null for one of this
   * router's own endpoints (ADR-008 §6).
   *
   * `IDX_evidence_snapshots_external_identity` is the identity key for these
   * rows: `endpointId` cannot discriminate them, and a unique index over a NULL
   * column groups nothing on either driver, so each origin gets its own.
   */
  @Index('IDX_evidence_snapshots_externalEndpointId')
  @Column(idColumn({ nullable: true }))
  externalEndpointId!: string | null;

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

  /**
   * The workloads the snapshot declares, or null for a row filed before this
   * column existed — which is not the same as a producer that declares none, and
   * is why it is nullable rather than an empty list.
   */
  @Column(jsonColumn({ nullable: true }))
  workloads!: EvidenceWorkloadSummary[] | null;

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

  @ManyToOne(() => ExternalEndpoint, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'externalEndpointId' })
  externalEndpoint?: Relation<ExternalEndpoint>;
}

/**
 * Whether a snapshot names exactly one publisher, of exactly one kind.
 *
 * The same rule as `generationEndpointIsExclusive`, enforced the same way — in
 * `invariants.spec.ts` rather than by a database CHECK, which TypeORM's schema
 * comparison does not track identically on PostgreSQL and SQLite.
 *
 * A row with both set would be filed under one of this router's endpoints *and*
 * under an upstream, so the console's digest history for the first would start
 * showing the second's publications. A row with neither belongs to nobody and no
 * screen can reach it.
 */
export function evidenceSnapshotEndpointIsExclusive(row: {
  endpointId: string | null;
  externalEndpointId: string | null;
}): boolean {
  return (row.endpointId === null) !== (row.externalEndpointId === null);
}
