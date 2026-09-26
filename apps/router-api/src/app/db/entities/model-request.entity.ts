import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn, type Relation } from 'typeorm';
import { idColumn, idPrimaryColumn, timestampColumn } from '../columns.js';
import { Workspace } from './workspace.entity.js';

/**
 * Which screen the request was raised from.
 *
 * The spellings are the analytics taxonomy's `model_requested.source`
 * (`schemas/analytics-taxonomy.json`), not a second vocabulary: the column and
 * the event property have to be the same word or the export and the funnel
 * cannot be read side by side.
 */
export const MODEL_REQUEST_SOURCES = ['models_page', 'empty_state', 'dashboard'] as const;

export type ModelRequestSource = (typeof MODEL_REQUEST_SOURCES)[number];

/**
 * One "serve this model" ask, kept exactly as often as it was made.
 *
 * There is deliberately no unique index anywhere on this table and no
 * deduplication on the way in. The same model asked for by forty people **is**
 * the signal, and an upsert keyed on the name would throw away the only number
 * worth reading; the aggregation collapses the rows at read time instead
 * (`ModelRequestsService.demand`).
 *
 * `normalisedModel` is stored rather than computed per query because the
 * aggregation groups on it and the grouping has to be an index hit — and
 * because `LOWER(TRIM(…))` in SQL would only cover the easy half of what
 * `normaliseModelName` does. `requestedModel` keeps the spelling the requester
 * typed, so the export shows what a person actually asked for.
 *
 * No database foreign key on `userId`: Better Auth owns the `user` table
 * (ADR-004 §3).
 */
@Entity({ name: 'model_requests' })
export class ModelRequest {
  @PrimaryColumn(idPrimaryColumn())
  id!: string;

  @Index('IDX_model_requests_userId')
  @Column(idColumn())
  userId!: string;

  @Column(idColumn())
  workspaceId!: string;

  /** What the requester typed, verbatim — a model name or a Hugging Face id. */
  @Column({ type: 'varchar', length: 200 })
  requestedModel!: string;

  /** The grouping key. See {@link normaliseModelName}. */
  @Index('IDX_model_requests_normalisedModel')
  @Column({ type: 'varchar', length: 200 })
  normalisedModel!: string;

  /** Why they want it, if they said. Free text, and it never leaves the database. */
  @Column({ type: 'text', nullable: true })
  note!: string | null;

  /** Whether they asked to be told when it is served. */
  @Column({ type: 'boolean', default: false })
  notify!: boolean;

  @Column({ type: 'varchar', length: 32 })
  source!: ModelRequestSource;

  @Index('IDX_model_requests_createdAt')
  @Column(timestampColumn())
  createdAt!: Date;

  @ManyToOne(() => Workspace, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'workspaceId' })
  workspace?: Relation<Workspace>;
}
