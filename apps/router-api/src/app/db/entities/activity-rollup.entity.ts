import { Column, Entity, PrimaryColumn } from 'typeorm';
import { bigIntColumn, idPrimaryColumn, timestampPrimaryColumn } from '../columns.js';

/**
 * Hourly aggregate of `generations`, maintained by a rollup job.
 *
 * Derived data: it can be dropped and rebuilt from `generations` at any time. It
 * exists so the Activity screen never scans the generation table, which is the
 * one table that grows without bound.
 */
@Entity({ name: 'activity_rollups' })
export class ActivityRollup {
  @PrimaryColumn(idPrimaryColumn())
  workspaceId!: string;

  @PrimaryColumn({ type: 'varchar', length: 255 })
  modelId!: string;

  /** Empty string rather than null: SQLite excludes null rows from a unique PK. */
  @PrimaryColumn(idPrimaryColumn({ default: '' }))
  apiKeyId!: string;

  /** Start of the hour this row aggregates. */
  @PrimaryColumn(timestampPrimaryColumn())
  bucket!: Date;

  @Column({ type: 'int', default: 0 })
  requests!: number;

  /** Of `requests`, how many were served while the endpoint had published evidence. */
  @Column({ type: 'int', default: 0 })
  coveredRequests!: number;

  @Column(bigIntColumn({ default: 0 }))
  promptTokens!: number;

  @Column(bigIntColumn({ default: 0 }))
  completionTokens!: number;

  @Column(bigIntColumn({ default: 0 }))
  costMicros!: number;
}
