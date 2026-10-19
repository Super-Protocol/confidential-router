import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn, type Relation } from 'typeorm';
import { bigIntColumn, idColumn, timestampColumn } from '../columns.js';
import { ApiKey } from './api-key.entity.js';
import { EvidenceSnapshot } from './evidence-snapshot.entity.js';
import { Model } from './model.entity.js';
import { Workspace } from './workspace.entity.js';

/**
 * The life of one metered request.
 *
 * `pending` is the row as it exists *while* the request is in flight: written
 * at admission, before anything is forwarded, and replaced by one of the three
 * terminal values when the gateway closes it. It is what makes a request that
 * the router never got to close — the process was restarted under it, the pod
 * was evicted, the edge answered the client 502 and tore the socket down —
 * visible at all instead of absent (SUP-423). `IncompleteGenerationSweeper`
 * closes a row left pending past `metering.incompleteAfter` as
 * `error` / `no_response`.
 */
export type GenerationStatus = 'pending' | 'ok' | 'error' | 'aborted';

/**
 * One metered request, written in two phases.
 *
 * The row is inserted when the request is admitted (`status: 'pending'`) and
 * updated when it ends. Before SUP-423 it was inserted only at the end, which
 * meant any request the router did not live to finish left no trace at all: the
 * account that paid for sixty seconds of a failed stream had nothing in Logs to
 * point at. The insert costs one write on the hot path and buys the invariant
 * that an admitted request is always visible to the workspace that made it.
 *
 * **No prompt or completion content, ever** — the router
 * forwards bodies to LiteLLM and never inspects or persists them
 * (`docs/threat-model.md`). `invariants.spec.ts` walks this entity's metadata
 * and fails the build if a column capable of holding message text is added —
 * by type, by length, or by name.
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

  /**
   * One of this deployment's own endpoints, or null when the request left the
   * cluster space through the egress leg.
   *
   * Nullable since ADR-008 §6's egress leg landed, and deliberately *not*
   * backfilled with the external endpoint's id: `endpoints` and
   * `external_endpoints` are separate namespaces on purpose, and the endpoint
   * totals the console computes from this column are about hosts this router
   * publishes evidence for.
   */
  @Column(idColumn({ nullable: true }))
  endpointId!: string | null;

  /**
   * The external endpoint the request was forwarded to, or null for a model inside
   * this cluster space (ADR-008 §6) — what `usage.endpoint` names for an external
   * generation.
   *
   * Exactly one of the two is set, which is {@link generationEndpointIsExclusive}.
   */
  @Column(idColumn({ nullable: true }))
  externalEndpointId!: string | null;

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

  /**
   * Defaults to `ok` for the benefit of nothing in this codebase — every write
   * sets it — but the column is what the Logs screen filters on, so the two
   * phases of the row both have to be representable here. See
   * {@link GenerationStatus}.
   */
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

/**
 * Whether a metered request names exactly one endpoint, of exactly one kind.
 *
 * The same rule as `modelOriginIsExclusive`, for the same reason and enforced the
 * same way — in `invariants.spec.ts` rather than by a database CHECK, which
 * TypeORM's schema comparison does not track identically on PostgreSQL and SQLite.
 *
 * A row that broke it would not fail loudly. It would be counted twice: once in
 * the per-endpoint token totals the console computes from `endpointId`, and once
 * as external traffic — or, with both null, in neither, which is how a generation
 * becomes invisible to the only screen that could have found it.
 */
export function generationEndpointIsExclusive(row: {
  endpointId: string | null;
  externalEndpointId: string | null;
}): boolean {
  return (row.endpointId === null) !== (row.externalEndpointId === null);
}
