import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn, type Relation } from 'typeorm';
import { idPrimaryColumn, timestampColumn } from '../columns.js';
import { User } from './user.entity.js';
import { Workspace } from './workspace.entity.js';

export type WorkspaceRole = 'owner' | 'member';

/**
 * Membership edge. Team workspaces are not exposed in the v1 console, but the
 * table exists from day one so adding them stays an additive change (ADR-004 §5).
 */
@Entity({ name: 'workspace_members' })
export class WorkspaceMember {
  @PrimaryColumn(idPrimaryColumn())
  workspaceId!: string;

  @PrimaryColumn(idPrimaryColumn())
  userId!: string;

  @Column({ type: 'varchar', length: 16, default: 'member' })
  role!: WorkspaceRole;

  @Column(timestampColumn())
  createdAt!: Date;

  @ManyToOne(
    () => Workspace,
    (workspace) => workspace.members,
    { onDelete: 'CASCADE' },
  )
  @JoinColumn({ name: 'workspaceId' })
  workspace?: Relation<Workspace>;

  /**
   * No database-level foreign key: the `user` table belongs to Better Auth's
   * migration, and this app's TypeORM migration stays runnable on its own.
   */
  @ManyToOne(
    () => User,
    (user) => user.memberships,
    { onDelete: 'CASCADE', createForeignKeyConstraints: false },
  )
  @JoinColumn({ name: 'userId' })
  user?: Relation<User>;
}
