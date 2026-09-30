import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn, type Relation } from 'typeorm';
import { bigIntColumn, idColumn, idPrimaryColumn, jsonColumn, timestampColumn } from '../columns.js';
import { Workspace } from './workspace.entity.js';

/**
 * Why a key exists, when it was not a person clicking "Create key".
 *
 * `null` is the ordinary case: a credential the user made for their own client.
 * `console_chat` is the short-lived key the console's Chat screen mints for
 * itself (SUP-180) — the chat calls the same `/v1/chat/completions` as any other
 * client, so it needs a real key, and marking it is what lets the console find
 * and rotate its own rather than accumulating them.
 *
 * A marker, not a permission: nothing in the gateway reads it, and a
 * `console_chat` key authenticates and meters exactly like any other.
 */
export type ApiKeyPurpose = 'console_chat';

/**
 * A `/v1/*` credential. Only `sha256(key)` is stored — the plaintext is shown
 * once, at creation, and cannot be recovered afterwards.
 */
@Entity({ name: 'api_keys' })
export class ApiKey {
  @PrimaryColumn(idPrimaryColumn())
  id!: string;

  @Index('IDX_api_keys_workspaceId')
  @Column(idColumn())
  workspaceId!: string;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Index('IDX_api_keys_keyHash', { unique: true })
  @Column({ type: 'varchar', length: 64 })
  keyHash!: string;

  /** First 12 characters of the key, for display only (`sk-tee-v1-4f`). */
  @Column({ type: 'varchar', length: 16 })
  prefix!: string;

  /** See {@link ApiKeyPurpose}. Null for every key a person created. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  purpose!: ApiKeyPurpose | null;

  /** Model ids this key may call. `null` means every model. */
  @Column(jsonColumn({ nullable: true }))
  modelScope!: string[] | null;

  @Column(bigIntColumn({ nullable: true }))
  spendLimitMicros!: number | null;

  @Column(bigIntColumn({ default: 0 }))
  spentTotalMicros!: number;

  @Column({ type: 'int', nullable: true })
  requestsPerMinute!: number | null;

  @Column({ type: 'int', nullable: true })
  tokensPerMinute!: number | null;

  @Column(timestampColumn({ nullable: true }))
  expiresAt!: Date | null;

  @Column(timestampColumn({ nullable: true }))
  lastUsedAt!: Date | null;

  @Column(timestampColumn({ nullable: true }))
  revokedAt!: Date | null;

  /** Nulled when the creating user is deleted; the key itself survives. */
  @Column(idColumn({ nullable: true }))
  createdByUserId!: string | null;

  @Column(timestampColumn())
  createdAt!: Date;

  @ManyToOne(
    () => Workspace,
    (workspace) => workspace.apiKeys,
    { onDelete: 'CASCADE' },
  )
  @JoinColumn({ name: 'workspaceId' })
  workspace?: Relation<Workspace>;
}
