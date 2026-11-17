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
/**
 * The retention sweep's index: "the oldest rows that still have a payload"
 * (`preferences/evidence-retention.service.ts`). Leading on
 * {@link EvidenceSnapshot.payloadStrippedAt} rather than on `issuedAt`, because
 * what makes the sweep cheap over time is that a row it has already emptied
 * leaves the range for good — on this order the scan shrinks as the backlog
 * drains, and in a steady state it covers only the rows still inside somebody's
 * window.
 */
@Index('IDX_evidence_snapshots_retention', ['payloadStrippedAt', 'issuedAt'])
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

  /**
   * Compact JWS as published, or null once the retention sweep has taken it
   * (`preferences/evidence-retention.service.ts`, SUP-498).
   *
   * Nullable since the sweep exists, not before it: every row written by a
   * poller carries a JWS, and a reader that finds none is reading a row whose
   * retention window has closed. {@link payloadStrippedAt} is how the two are
   * told apart.
   */
  @Column({ type: 'text', nullable: true })
  jws!: string | null;

  /**
   * Raw bundle as published, or null once the retention sweep has taken it.
   *
   * This and {@link jws} are the two columns `UserPreferences.evidenceRetentionDays`
   * governs, and they go together: a bundle without its signature is not
   * verifiable, and a signature without its bundle has nothing to verify. The
   * digests beside them are kept, which is the distinction `/privacy`'s
   * attestation row publishes.
   */
  @Column(jsonColumn({ nullable: true }))
  bundle!: Record<string, unknown> | null;

  /**
   * When the retention sweep removed {@link jws} and {@link bundle}, or null
   * while the row still carries them.
   *
   * The column exists because "no payload" has two meanings and a reader has to
   * tell them apart: a row the sweep has emptied, which is the published promise
   * being kept, and a row that never had one, which would be a parser bug. It is
   * also the only durable record that the sweep ran at all — `/health` reports
   * what this process did, and a process that booted an hour ago has no memory of
   * last week.
   */
  @Column(timestampColumn({ nullable: true }))
  payloadStrippedAt!: Date | null;

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

/** A snapshot that still carries the two documents the retention sweep removes. */
export type PublishedEvidenceSnapshot = EvidenceSnapshot & { jws: string; bundle: Record<string, unknown> };

/**
 * Whether this row still holds its published documents.
 *
 * A type guard rather than two null checks at each call site: every reader of
 * `bundle` or `jws` has to handle a swept row since SUP-498, and the ones that
 * hand the documents onward (the relay, the audit export) want the narrowed type
 * rather than a non-null assertion.
 */
export function evidenceSnapshotHasPayload(row: EvidenceSnapshot): row is PublishedEvidenceSnapshot {
  return row.jws !== null && row.bundle !== null;
}
