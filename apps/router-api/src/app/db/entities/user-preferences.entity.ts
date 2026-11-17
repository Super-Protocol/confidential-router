import { Column, Entity, JoinColumn, OneToOne, PrimaryColumn, type Relation } from 'typeorm';
import { idPrimaryColumn, timestampColumn } from '../columns.js';
import { User } from './user.entity.js';

/** Per-user console settings. One row per user, created lazily on first write. */
@Entity({ name: 'user_preferences' })
export class UserPreferences {
  @PrimaryColumn(idPrimaryColumn())
  userId!: string;

  /**
   * Whether this account holds the archived bundles of the publications that
   * served it.
   *
   * Read by `EvidenceRetentionService`: an account with this off contributes
   * nothing to the retention maximum over a publication's holders, so a
   * publication only such accounts hold is past its window immediately. It is
   * **not** a switch on the poller — every bundle is still fetched and filed,
   * because the live publication's bundle is what `GET /v1/evidence/{endpoint}`
   * relays — and it cannot remove a row other accounts still hold, the table
   * being per publication rather than per account.
   */
  @Column({ type: 'boolean', default: true })
  archiveEvidence!: boolean;

  /**
   * Applies to the `bundle`/`jws` blobs only; digests are kept forever.
   *
   * Ignored while {@link archiveEvidence} is off — this account holds nothing to
   * apply a window to — but still settable, so the window is already right when
   * the switch goes back on.
   */
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
