import { Column, Entity, Index, OneToMany, PrimaryColumn, type Relation } from 'typeorm';
import { idPrimaryColumn, jsonColumn, timestampColumn } from '../columns.js';
import { EvidenceSnapshot } from './evidence-snapshot.entity.js';
import { Model } from './model.entity.js';

/** One `{ name, digest }` pair of an endpoint's declared image allow-list. */
export interface DeclaredImage {
  /** Image reference without tag or digest, e.g. `ghcr.io/super-protocol/router-api`. */
  name: string;
  /** `sha256:<64 hex>`. */
  digest: string;
}

/**
 * A router hostname for which the platform publishes
 * `/.well-known/swarm-evidence` (ADR-002).
 *
 * Projection of `endpoints[]` in the router config, re-derived at boot: the
 * config is the source of truth, these rows exist for referential integrity and
 * history. A row is never edited through the API; a removed endpoint is kept
 * with `enabled = false` so past generations still resolve.
 */
@Entity({ name: 'endpoints' })
export class Endpoint {
  @PrimaryColumn(idPrimaryColumn())
  id!: string;

  @Index('IDX_endpoints_name', { unique: true })
  @Column({ type: 'varchar', length: 64 })
  name!: string;

  @Index('IDX_endpoints_hostname', { unique: true })
  @Column({ type: 'varchar', length: 255 })
  hostname!: string;

  /** Operator-declared TEE label, shown in the console. Never a verdict. */
  @Column({ type: 'varchar', length: 128 })
  tee!: string;

  @Column({ type: 'varchar', length: 2048, nullable: true })
  evidenceUrl!: string | null;

  /**
   * The operator's image allow-list for this endpoint, pinned by digest, or null
   * when the config declares none.
   *
   * Null and `[]` are different answers and both are kept: null is "nothing was
   * declared", which the console reports as such, and an empty list is "this
   * endpoint is declared to run nothing", under which every image the evidence
   * carries is undeclared. Projected from `endpoints[].declaredImages`, never
   * edited through the API — same rule as every other column here.
   */
  @Column(jsonColumn({ nullable: true }))
  declaredImages!: DeclaredImage[] | null;

  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  @Column(timestampColumn())
  updatedAt!: Date;

  @OneToMany(
    () => Model,
    (model) => model.endpoint,
  )
  models?: Relation<Model[]>;

  @OneToMany(
    () => EvidenceSnapshot,
    (snapshot) => snapshot.endpoint,
  )
  evidenceSnapshots?: Relation<EvidenceSnapshot[]>;
}
