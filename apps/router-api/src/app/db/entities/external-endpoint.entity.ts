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
 * {@link TrustedMeasurement}, in {@link pinnedEvidenceDigest} — the one column
 * here that is an operator's decision rather than a verdict — and in the
 * evidence.
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

  /**
   * Where the last check stopped: an ADR-003 §1 stage (fetch, cert-chain, untrusted-root, jws,
   * tls-fingerprint, policy) or, for the built-in two-factor clause, the factor it refused on —
   * `digest-not-pinned`, `measurement-not-trusted` or `digest-mismatch` (SUP-252).
   */
  @Column({ type: 'varchar', length: 32, nullable: true })
  lastStage!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  lastReason!: string | null;

  /**
   * When a verdict last *admitted* this endpoint — the column that answers "is it
   * serving", as opposed to `lastCheckedAt`'s "when did we last look" (SUP-517).
   *
   * Null after a boot reset and until the first admitting verdict of this
   * process, which is why {@link notServingSince} exists beside it: an outage has
   * to be measurable without a success to measure it from.
   */
  @Column(timestampColumn({ nullable: true }))
  lastSuccessAt!: Date | null;

  /**
   * When a verdict last *denied* it, kept across a recovery — the one liveness
   * column a success does not clear, so "has this upstream been flapping" is
   * answerable from the row and not only from the timeline.
   */
  @Column(timestampColumn({ nullable: true }))
  lastFailureAt!: Date | null;

  /**
   * Since when this endpoint has not been known to serve: set by a denial, by an
   * operator switching it back on, and by the boot reset — and cleared by an
   * admitting verdict. What `outage.afterNoSuccess` is measured from.
   *
   * Deliberately wider than "failing": `pending` serves nothing either, and an
   * upstream whose first check never arrives is as dark to a caller as one that
   * was refused. What keeps that from paging over a fresh registration is the
   * *expected to serve* gate in `external-endpoint-liveness.ts`, not a narrower
   * reading of this column.
   *
   * A restart resets it, like every other verdict projection (ADR-008 §8), so a
   * router restarted during an outage reports the outage as starting at the
   * restart. That loses the true start — the timeline's `outage` event keeps it —
   * and it is the right trade: the alternative is a persisted verdict.
   */
  @Column(timestampColumn({ nullable: true }))
  notServingSince!: Date | null;

  /**
   * Denials in the current run, counted per *distinct* check rather than per poll.
   *
   * The status poll reads the sidecar every 5 s and the sidecar re-attests every
   * 10 minutes, so the same denial is read back some 120 times; counting those
   * would make `outage.afterFailures` a number of seconds wearing a different
   * name. A check is new when the verdict's own `checkedAt` moved.
   *
   * Zero while the last verdict admitted, and zero while nothing has been checked
   * — "we have not looked yet" is not a failure (ADR-008 §8).
   */
  @Column({ type: 'int', default: 0 })
  consecutiveFailures!: number;

  /**
   * Whether the last check could not reach the upstream at all, as the *sidecar*
   * answered it (`SidecarReport.unreachable`, SUP-422).
   *
   * Read, never inferred. The `fetch` stage is wider than this: a non-2xx answer
   * to the bundle fetch, an over-sized bundle and a hostname the gatekeeper
   * refuses all stop at `fetch` while the upstream demonstrably answered. Calling
   * those unreachable would send an operator to look at a cloud that is up —
   * the same mis-direction SUP-517 exists to remove, pointing the other way.
   *
   * Null when nothing has been checked. A row that holds null and a stage of
   * `fetch` is a verdict projected before this column existed; the reader falls
   * back to the stage there, and the boot reset retires the question.
   */
  @Column({ type: 'boolean', nullable: true })
  upstreamUnreachable!: boolean | null;

  /** Normalised mrEnclave hex of the upstream cloud's root, as the verdict observed it. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  measurementSeen!: string | null;

  /** `registry` or `operator-pinned` — which anchor vouched for the measurement (SUP-139). */
  @Column({ type: 'varchar', length: 32, nullable: true })
  measurementSource!: string | null;

  /**
   * Whether the sidecar found {@link measurementSeen} signed in the Super Protocol
   * registry (`attestedRoot.inRegistry`), reported on a denial too. Informational
   * only: it never admits — the admin trust list is the sole authority (ADR-008 §3).
   * Null when no measurement was derived.
   */
  @Column({ type: 'boolean', nullable: true })
  measurementInRegistry!: boolean | null;

  /** Canonical `sha256/<base64url>` digest of the upstream deployment snapshot. */
  @Column({ type: 'varchar', length: 128, nullable: true })
  evidenceDigestSeen!: string | null;

  /**
   * The deployment an admin approved: the second trust factor (SUP-252).
   *
   * Unlike every verdict column above, this is **trust**, not a projection of one —
   * an operator's decision, rendered into the sidecar config as the endpoint's
   * `trustedEvidence`, and never written by the status poll or reset on boot.
   * Admission requires the verdict's {@link evidenceDigestSeen} to equal it *and*
   * the cloud's measurement to be on the trust list. Null means no deployment has
   * been approved yet, so the endpoint stays `pending` (`digest-not-pinned`).
   * Canonical `sha256/<base64url>`, the spelling the verdict reports.
   */
  @Column({ type: 'varchar', length: 128, nullable: true })
  pinnedEvidenceDigest!: string | null;

  /** The TLS leaf the sidecar pinned; egress verifies against this and no CA bundle. */
  @Column({ type: 'varchar', length: 128, nullable: true })
  pinnedCertFingerprint!: string | null;

  /**
   * The TLS leaf the last cryptographically verified report bound its evidence to —
   * set when the endpoint is admitted (it then equals {@link pinnedCertFingerprint})
   * *and* when a trust factor refused sound evidence (SUP-252). It is what the
   * evidence poller binds a fetched bundle to, so the console can show the
   * deployment an admin is being asked to approve. Never an egress pin: nothing
   * dials against it.
   */
  @Column({ type: 'varchar', length: 128, nullable: true })
  observedCertFingerprint!: string | null;

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
