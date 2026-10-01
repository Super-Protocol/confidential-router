import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn, type Relation } from 'typeorm';
import { idColumn, idPrimaryColumn, timestampColumn } from '../columns.js';
import { Workspace } from './workspace.entity.js';

/**
 * One console-chat conversation.
 *
 * This table and {@link ChatMessage} are **the one documented exception** to the
 * rule that no request content reaches this database (`docs/contracts/data-model.md`;
 * ADR-007 §4). The metering invariant still holds absolutely for `generations`:
 * a chat message travels to the model over the ordinary `/v1/chat/completions`
 * path, which records tokens, cost and model and no content at all. What is
 * stored here is the *transcript the user asked us to keep*, and nothing else in
 * the system may read it — not a log line, not an analytics event, not the
 * evidence export. `invariants.spec.ts` holds that boundary.
 *
 * Scoped to `(workspaceId, userId)`, not to the workspace: a workspace has
 * members, and one member's demo transcript is not another's to read. Every query
 * in `ChatService` carries both.
 *
 * No database foreign key on `userId`: Better Auth owns the `user` table
 * (ADR-004 §3). The workspace relation cascades, so deleting a tenant takes its
 * transcripts with it.
 */
@Entity({ name: 'chat_threads' })
@Index('IDX_chat_threads_workspaceId_userId_updatedAt', ['workspaceId', 'userId', 'updatedAt'])
export class ChatThread {
  @PrimaryColumn(idPrimaryColumn())
  id!: string;

  @Column(idColumn())
  workspaceId!: string;

  /** Whose transcript it is. Part of every lookup, never inferred. */
  @Column(idColumn())
  userId!: string;

  /**
   * Derived from the first user message, never typed by the user.
   *
   * It *is* content — a truncated copy of the opening question — which is why it
   * lives in this table and not on anything the rest of the console renders in a
   * list beside other tenants' data.
   */
  @Column({ type: 'varchar', length: 128 })
  title!: string;

  /** The model this thread is talking to. Switchable mid-thread. */
  @Column({ type: 'varchar', length: 255 })
  modelId!: string;

  @Column(timestampColumn())
  createdAt!: Date;

  /** Bumped on every append; the sort key and the pruning key. */
  @Column(timestampColumn())
  updatedAt!: Date;

  @ManyToOne(() => Workspace, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'workspaceId' })
  workspace?: Relation<Workspace>;
}
