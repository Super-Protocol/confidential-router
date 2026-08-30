import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn, type Relation } from 'typeorm';
import { bigIntColumn, idColumn, jsonColumn, timestampColumn } from '../columns.js';
import { Endpoint } from './endpoint.entity.js';

export type ModelCapability = 'chat' | 'completions' | 'embeddings';

/**
 * Projection of `models[]` in the router config, re-derived at boot. The primary
 * key is the public model id (`meta/llama-3.3-70b-instruct:tdx`) so a
 * `Generation` keeps pointing at the model it actually used even after the
 * config drops it.
 */
@Entity({ name: 'models' })
export class Model {
  @PrimaryColumn({ type: 'varchar', length: 255 })
  id!: string;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'varchar', length: 255 })
  litellmModel!: string;

  @Index('IDX_models_endpointId')
  @Column(idColumn())
  endpointId!: string;

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
}
