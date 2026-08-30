import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn, type Relation } from 'typeorm';
import { bigIntColumn, idColumn, timestampColumn } from '../columns.js';
import { ApiKey } from './api-key.entity.js';
import { EvidenceSnapshot } from './evidence-snapshot.entity.js';
import { Model } from './model.entity.js';
import { Workspace } from './workspace.entity.js';

export type GenerationStatus = 'ok' | 'error' | 'aborted';

/**
 * One metered request. **No prompt or completion content, ever** — the router
 * forwards bodies to LiteLLM and never inspects or persists them
 * (`docs/threat-model.md`). `generation.entity.spec.ts` walks this entity's
 * metadata and fails if a column capable of holding message text is added.
 */
@Entity({ name: 'generations' })
@Index('IDX_generations_workspaceId_createdAt', ['workspaceId', 'createdAt'])
export class Generation {
  /** `gen-<ulid>`; also the `id` of the OpenAI-shaped response. */
  @PrimaryColumn({ type: 'varchar', length: 64 })
  id!: string;

  @Index('IDX_generations_workspaceId')
  @Column(idColumn())
  workspaceId!: string;

  /** Nulled rather than cascaded when a key is deleted: the meter survives it. */
  @Column(idColumn({ nullable: true }))
  apiKeyId!: string | null;

  @Column({ type: 'varchar', length: 255 })
  modelId!: string;

  @Column(idColumn())
  endpointId!: string;

  /**
   * The snapshot that was current when the request was served, or null when the
   * endpoint had published nothing. This is "evidence coverage": a fact about
   * publication, not a verdict about validity.
   */
  @Column(idColumn({ nullable: true }))
  evidenceSnapshotId!: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  evidenceDigest!: string | null;

  @Column({ type: 'int', default: 0 })
  promptTokens!: number;

  @Column({ type: 'int', default: 0 })
  completionTokens!: number;

  @Column(bigIntColumn({ default: 0 }))
  costMicros!: number;

  /** Prices frozen at request time so a config change cannot rewrite history. */
  @Column(bigIntColumn())
  promptPer1mMicros!: number;

  @Column(bigIntColumn())
  completionPer1mMicros!: number;

  @Column({ type: 'boolean', default: false })
  streamed!: boolean;

  @Column({ type: 'varchar', length: 16, default: 'ok' })
  status!: GenerationStatus;

  @Column({ type: 'varchar', length: 64, nullable: true })
  errorCode!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  finishReason!: string | null;

  @Column({ type: 'int', default: 0 })
  latencyMs!: number;

  @Column({ type: 'int', nullable: true })
  timeToFirstTokenMs!: number | null;

  @Column({ type: 'real', nullable: true })
  tokensPerSecond!: number | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  requestId!: string | null;

  /** Salted hash, for abuse investigation. The address itself is never stored. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  clientIpHash!: string | null;

  @Column(timestampColumn())
  createdAt!: Date;

  @ManyToOne(
    () => Workspace,
    (workspace) => workspace.generations,
    { onDelete: 'CASCADE' },
  )
  @JoinColumn({ name: 'workspaceId' })
  workspace?: Relation<Workspace>;

  @ManyToOne(() => ApiKey, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'apiKeyId' })
  apiKey?: Relation<ApiKey> | null;

  @ManyToOne(() => Model, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'modelId' })
  model?: Relation<Model>;

  @ManyToOne(() => EvidenceSnapshot, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'evidenceSnapshotId' })
  evidenceSnapshot?: Relation<EvidenceSnapshot> | null;
}
