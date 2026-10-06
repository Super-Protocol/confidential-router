import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn, type Relation } from 'typeorm';
import { bigIntColumn, idColumn, jsonColumn, timestampColumn } from '../columns.js';
import { Endpoint } from './endpoint.entity.js';
import { ExternalEndpoint } from './external-endpoint.entity.js';

export type ModelCapability = 'chat' | 'completions' | 'embeddings';

/**
 * Where a catalogue row comes from, and therefore who may edit it.
 *
 * `config` is the historical and still the default kind: a projection of
 * `models[]`, re-derived at boot and immutable through the API
 * (`docs/contracts/data-model.md` invariant 4). `external` is an admin-managed
 * row pointing at another deployment's endpoint (ADR-008 §6), written at runtime
 * and never touched by the boot projection.
 */
export type ModelOrigin = 'config' | 'external';

/**
 * One model the gateway can route to. The primary key is the public model id
 * (`meta/llama-3.3-70b-instruct:tdx`) so a `Generation` keeps pointing at the
 * model it actually used even after the config drops it.
 *
 * Two origins share the table ({@link ModelOrigin}): a projection of `models[]`
 * re-derived at boot, and an admin-registered model on an external endpoint
 * (ADR-008 §6). Exactly one of `endpointId` / `externalEndpointId` is set.
 */
@Entity({ name: 'models' })
export class Model {
  @PrimaryColumn({ type: 'varchar', length: 255 })
  id!: string;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  /**
   * The name the *upstream* knows this model by: LiteLLM's `model` for a config
   * row, the external endpoint's own model id for an external one.
   */
  @Column({ type: 'varchar', length: 255 })
  litellmModel!: string;

  /**
   * Which of the two sources owns this row. Defaulted rather than nullable so
   * every row written before ADR-008 reads as what it is.
   */
  @Column({ type: 'varchar', length: 16, default: 'config' })
  origin!: ModelOrigin;

  /** Set for `origin: 'config'`, null for `origin: 'external'`. */
  @Index('IDX_models_endpointId')
  @Column(idColumn({ nullable: true }))
  endpointId!: string | null;

  /**
   * Set for `origin: 'external'`, null for `origin: 'config'` — exclusively, which
   * is what keeps one catalogue table serving `/v1/models`, key scopes, metering,
   * Activity and Logs without a union. Enforced by `invariants.spec.ts` rather
   * than by a database CHECK, which TypeORM's schema comparison does not track
   * identically on both drivers.
   */
  @Index('IDX_models_externalEndpointId')
  @Column(idColumn({ nullable: true }))
  externalEndpointId!: string | null;

  @Column({ type: 'int' })
  contextLength!: number;

  @Column(jsonColumn())
  capabilities!: ModelCapability[];

  @Column(bigIntColumn())
  promptPer1mMicros!: number;

  @Column(bigIntColumn())
  completionPer1mMicros!: number;

  /** Denormalised from the endpoint so a model list needs no join. */
  @Column({ type: 'varchar', length: 128 })
  tee!: string;

  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  @Column(timestampColumn())
  updatedAt!: Date;

  @ManyToOne(
    () => Endpoint,
    (endpoint) => endpoint.models,
    { onDelete: 'RESTRICT' },
  )
  @JoinColumn({ name: 'endpointId' })
  endpoint?: Relation<Endpoint>;

  @ManyToOne(() => ExternalEndpoint, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'externalEndpointId' })
  externalEndpoint?: Relation<ExternalEndpoint>;
}

/**
 * Whether a catalogue row names exactly one endpoint, of the kind its origin says.
 *
 * Data-model invariant 4's exclusivity rule, as one function, because it is
 * enforced by whoever writes a row rather than by a database CHECK — TypeORM's
 * schema comparison does not track checks identically on PostgreSQL and SQLite,
 * and `migrations.spec.ts` requires that comparison to come back empty.
 *
 * A row that broke it would not fail loudly; it would be listed by `/v1/models`
 * and resolved by the gateway through two different joins, which is why the rule
 * is checked rather than assumed.
 */
export function modelOriginIsExclusive(row: {
  origin: ModelOrigin;
  endpointId: string | null;
  externalEndpointId: string | null;
}): boolean {
  return row.origin === 'config'
    ? row.endpointId !== null && row.externalEndpointId === null
    : row.endpointId === null && row.externalEndpointId !== null;
}
