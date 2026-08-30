import { Column, Entity, JoinColumn, OneToOne, PrimaryColumn, type Relation } from 'typeorm';
import { idPrimaryColumn, timestampColumn } from '../columns.js';
import { User } from './user.entity.js';

/** Per-user console settings. One row per user, created lazily on first write. */
@Entity({ name: 'user_preferences' })
export class UserPreferences {
  @PrimaryColumn(idPrimaryColumn())
  userId!: string;

  @Column({ type: 'boolean', default: true })
  archiveEvidence!: boolean;

  /** Applies to the `bundle`/`jws` blobs only; digests are kept forever. */
  @Column({ type: 'int', default: 90 })
  evidenceRetentionDays!: number;

  @Column({ type: 'boolean', default: true })
  notifyOnMeasurementChange!: boolean;

  @Column({ type: 'boolean', default: false })
  desktopNotifications!: boolean;

  @Column({ type: 'boolean', default: true })
  emailReceipts!: boolean;

  @Column(timestampColumn())
  updatedAt!: Date;

  /** No database-level foreign key — see `WorkspaceMember.user`. */
  @OneToOne(() => User, { onDelete: 'CASCADE', createForeignKeyConstraints: false })
  @JoinColumn({ name: 'userId' })
  user?: Relation<User>;
}
