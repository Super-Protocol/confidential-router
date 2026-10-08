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
 * approved.
 */
export type ExternalEndpointEventKind =
  | 'registered'
  | 'verified'
  | 'denied'
  | 'digest_changed'
  | 'digest_pinned'
  | 'measurement_changed'
  | 'disabled'
  | 'key_rotated';

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
