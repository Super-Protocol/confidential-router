import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { idColumn, idPrimaryColumn, timestampColumn } from '../columns.js';

/**
 * One deployment export this deployment has taken (SUP-481).
 *
 * Written by `DataImportService.apply`, read by nothing else — and it exists for
 * one decision: whether a *second* import of the same dataset is allowed to run
 * on a deployment that has meanwhile been signed up to.
 *
 * The rebuild shape is export → import → verify → hand the hostname over, and
 * the verification is a real sign-up on the new deployment. That sign-up used to
 * make every later import refuse ("this deployment is not fresh"), which left no
 * way to catch up the rows the old deployment served in between. A row here is
 * the deployment remembering where its data came from, so the freshness test can
 * be "nobody else's data is here" rather than "nobody at all": a bundle from the
 * same source may be imported again, and whatever signed up here since is kept.
 *
 * Append-only, never updated. Nothing is derived from it except that answer and
 * the line the console shows above the import plan.
 */
@Entity({ name: 'data_imports' })
export class DataImport {
  @PrimaryColumn(idPrimaryColumn())
  id!: string;

  /** `source.publicBaseUrl` of the bundle: which deployment's data this is. */
  @Column({ type: 'varchar', length: 2048 })
  sourcePublicBaseUrl!: string;

  /** The router version that wrote the bundle. */
  @Column({ type: 'varchar', length: 64 })
  sourceRouterVersion!: string;

  /** The bundle's `exportedAt` — how far behind the source this deployment was left. */
  @Column(timestampColumn())
  bundleExportedAt!: Date;

  /** The bundle's content hash, so a row names exactly one file. */
  @Column({ type: 'varchar', length: 64 })
  contentSha256!: string;

  /** The operator who ran it. No FK — Better Auth owns `user` (ADR-004 §3). */
  @Column(idColumn({ nullable: true }))
  importedByUserId!: string | null;

  @Index('IDX_data_imports_importedAt')
  @Column(timestampColumn())
  importedAt!: Date;
}
