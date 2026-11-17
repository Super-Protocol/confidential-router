import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn, type Relation } from 'typeorm';
import { idColumn, idPrimaryColumn, timestampColumn } from '../columns.js';
import { ExternalEndpoint } from './external-endpoint.entity.js';

/**
 * What happened to an external endpoint, in order.
 *
 * `digest_changed` and `measurement_changed` are reported on every change. Under
 * two-factor trust (SUP-252) a digest change is also *gating* — the pinned digest
 * no longer matches, so the same pass records the `denied` it caused — and
 * `digest_pinned` is the admin's approval of a deployment, carrying the digest
 * approved. `digest_unpinned` is its counterpart: the approval an edit withdrew,
 * carrying the digest that is no longer approved and the reason it went (SUP-435)
 * — without it, an endpoint that stops serving after a re-point has nothing in
 * its own history that says why.
 *
 * `outage` and `recovered` are the sustained-failure pair (SUP-517), and they are
 * deliberately not `denied`/`verified` under another name. A `denied` is one check
 * that refused; an `outage` is this router declaring that the run of them has
 * passed the configured threshold and is worth waking somebody for. The timeline
 * needs both, because "it failed once at 06:11" and "it has been failing since
 * 06:11" are the two different things an operator reads a history to tell apart.
 *
 * `verdict_expired` is the third member of that family and the one that is not
 * about the upstream at all (SUP-583): this router let go of an admitting verdict
 * because the egress sidecar stopped confirming it. A `denied` says the upstream
 * was judged and refused; this says nothing was judged, and the row stopped
 * claiming otherwise. An operator reading it should look at the sidecar, not at
 * the cloud.
 */
export type ExternalEndpointEventKind =
  | 'registered'
  | 'verified'
  | 'denied'
  | 'digest_changed'
  | 'digest_pinned'
  | 'digest_unpinned'
  | 'measurement_changed'
  | 'disabled'
  | 'key_rotated'
  | 'outage'
  | 'recovered'
  | 'verdict_expired';

/**
 * Append-only timeline of one external endpoint — the verdict history the admin
 * section renders.
 *
 * History, never input. {@link ExternalEndpoint} is re-derived from live
 * verification on every boot and these rows are not consulted when it is; a
 * reader that treated a past `verified` as current trust would be reintroducing
 * exactly the persisted verdict ADR-008 §8 refuses. Accordingly there is no
 * `updatedAt`: a row is written once and never edited.
 */
@Entity({ name: 'external_endpoint_events' })
@Index('IDX_external_endpoint_events_endpointId_at', ['externalEndpointId', 'at'])
export class ExternalEndpointEvent {
  @PrimaryColumn(idPrimaryColumn())
  id!: string;

  @Column(idColumn())
  externalEndpointId!: string;

  @Column(timestampColumn())
  at!: Date;

  @Column({ type: 'varchar', length: 32 })
  kind!: ExternalEndpointEventKind;

  @Column({ type: 'varchar', length: 32, nullable: true })
  stage!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  reason!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  measurement!: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  evidenceDigest!: string | null;

  @ManyToOne(
    () => ExternalEndpoint,
    (endpoint) => endpoint.events,
    { onDelete: 'CASCADE' },
  )
  @JoinColumn({ name: 'externalEndpointId' })
  externalEndpoint?: Relation<ExternalEndpoint>;
}
