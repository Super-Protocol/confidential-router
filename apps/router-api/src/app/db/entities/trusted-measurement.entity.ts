import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { idColumn, idPrimaryColumn, timestampColumn } from '../columns.js';

/**
 * One VM launch measurement this deployment accepts for an external upstream —
 * the admin trust list, and the sole authority on admission (ADR-008 §3).
 *
 * The value is the normalised mrEnclave hex of the upstream cloud's root CA, the
 * only measurement every Swarm deployment has today. It admits a *cloud*, never
 * a deployment: any TEE on a listed cloud satisfies it, which is decision 1's
 * trade and threat T13. The console says so wherever this list is edited.
 *
 * Rendered into the sidecar's `attestedRoots.trustedMeasurements`. A row removed
 * here denies on the next forced re-check, which drops the upstream's models and
 * closes its in-flight connections — so a delete is a live, fail-closed action,
 * not a tidy-up.
 */
@Entity({ name: 'trusted_measurements' })
export class TrustedMeasurement {
  @PrimaryColumn(idPrimaryColumn())
  id!: string;

  /** 64 lower-case hex characters. Unique: the list is a set, and a duplicate pin is a no-op. */
  @Index('IDX_trusted_measurements_measurement', { unique: true })
  @Column({ type: 'varchar', length: 64 })
  measurement!: string;

  /** Why this cloud is trusted, in the operator's own words. Shown beside the entry. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  note!: string | null;

  /** No foreign key: Better Auth owns `user` (ADR-004 §3). */
  @Column(idColumn({ nullable: true }))
  addedByUserId!: string | null;

  @Column(timestampColumn())
  addedAt!: Date;
}
