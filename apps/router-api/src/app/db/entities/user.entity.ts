import { Column, Entity, OneToMany, PrimaryColumn, type Relation } from 'typeorm';
import { idPrimaryColumn } from '../columns.js';
import { ForeignDateTransformer } from '../transformers.js';
import { WorkspaceMember } from './workspace-member.entity.js';

/**
 * Read-only projection of the `user` table Better Auth owns (ADR-004).
 *
 * `synchronize: false` and no TypeORM migration ever touches it: Better Auth's
 * own migration creates and evolves the four auth tables, and this entity exists
 * only so the console can join a session's user onto workspaces and preferences.
 * Nothing in this codebase may write through it.
 */
@Entity({ name: 'user', synchronize: false })
export class User {
  @PrimaryColumn(idPrimaryColumn())
  id!: string;

  @Column({ type: 'varchar', length: 320 })
  email!: string;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'varchar', length: 2048, nullable: true })
  image!: string | null;

  // Physical type differs per database because Better Auth created it.
  @Column({ type: 'varchar', transformer: ForeignDateTransformer })
  createdAt!: Date;

  @OneToMany(
    () => WorkspaceMember,
    (member) => member.user,
  )
  memberships?: Relation<WorkspaceMember[]>;
}
