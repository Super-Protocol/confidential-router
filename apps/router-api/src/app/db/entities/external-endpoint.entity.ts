import { Column, Entity, Index, OneToMany, PrimaryColumn, type Relation } from 'typeorm';
import { idColumn, idPrimaryColumn, timestampColumn } from '../columns.js';
import { ExternalEndpointEvent } from './external-endpoint-event.entity.js';

/**
 * What the egress sidecar currently says about an upstream, projected.
 *
 * `pending` is the state every row starts and restarts in: no verdict has been
 * read back yet, so the endpoint serves nothing (ADR-008 §8). `disabled` is the
 * operator's own switch and is the one value the status poll never writes.
 */
export type ExternalEndpointStatus = 'pending' | 'verified' | 'denied' | 'disabled';

/**
 * A model endpoint in *someone else's* deployment, registered at runtime by an
 * admin and attested by this router before any prompt is proxied (ADR-008).
 *
 * This is the mirror image of {@link Endpoint}. There the router publishes
 * evidence about itself and stores no verdict, because the verdict is the user's
 * gatekeeper's to make (ADR-002). Here the router is the client that fetches an
 * upstream's evidence, verifies it and refuses to send traffic without a valid
 * verdict — so the columns below *are* verdict state, and
 * `docs/contracts/data-model.md` invariant 2 is narrowed to say so.
 *
 * Every one of them is display and admission state re-derived from a live
 * verification, never an input to one: on boot the row is forced back to
 * `pending` and the sidecar re-attests from nothing. Trust lives in
 * {@link TrustedMeasurement} and in the evidence, never in this table.
 */
@Entity({ name: 'external_endpoints' })
export class ExternalEndpoint {
  @PrimaryColumn(idPrimaryColumn())
  id!: string;

  /**
   * Its own namespace, deliberately not shared with `endpoints`: that table
   * holds the router's own hostnames, and a name collision between "a host we
   * publish evidence for" and "a host we verify" would be a trust confusion.
   *
   * Also the sidecar's endpoint key, so it obeys the gatekeeper config's
   * kebab-case `name` pattern.
   */
  @Index('IDX_external_endpoints_name', { unique: true })
  @Column({ type: 'varchar', length: 64 })
  name!: string;

  /** `https://host[:port]` — the OpenAI-compatible `/v1` surface, without the path. */
  @Column({ type: 'varchar', length: 2048 })
  baseUrl!: string;

  /** Derived from {@link baseUrl}; what the evidence bundle is fetched from and bound to. */
  @Column({ type: 'varchar', length: 255 })
  hostname!: string;

  /**
   * The sidecar's loopback listener for this endpoint, allocated deterministically
   * and recorded here so a restart renders the same config and router-api's egress
   * leg keeps pointing at the same port.
   */
  @Column({ type: 'int' })
  listenPort!: number;

  /** The operator's switch. A disabled endpoint is not rendered into the sidecar config at all. */
  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status!: ExternalEndpointStatus;

  @Column(timestampColumn({ nullable: true }))
  lastCheckedAt!: Date | null;

  /** ADR-003 §1 stage name of the last failure: fetch, cert-chain, untrusted-root, jws, tls-fingerprint, policy. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  lastStage!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  lastReason!: string | null;

  /** Normalised mrEnclave hex of the upstream cloud's root, as the verdict observed it. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  measurementSeen!: string | null;

  /** `registry` or `operator-pinned` — which anchor vouched for the measurement (SUP-139). */
  @Column({ type: 'varchar', length: 32, nullable: true })
  measurementSource!: string | null;

  /** Canonical `sha256/<base64url>` digest of the upstream deployment snapshot. */
  @Column({ type: 'varchar', length: 128, nullable: true })
  evidenceDigestSeen!: string | null;

  /** The TLS leaf the sidecar pinned; egress verifies against this and no CA bundle. */
  @Column({ type: 'varchar', length: 128, nullable: true })
  pinnedCertFingerprint!: string | null;

  /**
   * The upstream's LLM API key, sealed by `secret-envelope.ts`.
   *
   * Write-only: no read path returns it, rotation is a new write, and the
   * plaintext exists only inside the request that seals it and inside the egress
   * leg that injects it. See `docs/adr/ADR-008-external-model-endpoints.md` §6
   * and threat T15.
   */
  @Column({ type: 'varchar', length: 1024 })
  apiKeyCiphertext!: string;

  /** Leading characters of the plaintext, kept so the console can identify the key it cannot read. */
  @Column({ type: 'varchar', length: 16 })
  apiKeyPrefix!: string;

  /** No foreign key: Better Auth owns `user` (ADR-004 §3). */
  @Column(idColumn({ nullable: true }))
  createdByUserId!: string | null;

  @Column(timestampColumn())
  createdAt!: Date;

  @Column(timestampColumn())
  updatedAt!: Date;

  @OneToMany(
    () => ExternalEndpointEvent,
    (event) => event.externalEndpoint,
  )
  events?: Relation<ExternalEndpointEvent[]>;
}
