import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn, type Relation } from 'typeorm';
import { idColumn, idPrimaryColumn, timestampColumn } from '../columns.js';
import { ChatThread } from './chat-thread.entity.js';

/** Who said it. There is no `system` role: the chat sends no prompt of its own. */
export type ChatRole = 'user' | 'assistant';

/**
 * One turn of a console-chat conversation, content and all.
 *
 * The second half of the exception documented on {@link ChatThread}. `content`
 * is the only unbounded-text column in the schema that holds anything a user
 * typed or a model answered, and it is bounded by `chat.maxMessageChars`, which
 * `ChatService` enforces before the insert — refusing a question over it, and
 * cutting an answer over it short rather than discarding tokens already paid
 * for.
 *
 * `error` exists because a failed turn is part of the transcript: a stream that
 * died halfway is more honest kept, with what arrived and why it stopped, than
 * silently dropped. It holds the gateway's own refusal message — or the note
 * that the answer was cut at the ceiling — never a stack.
 */
@Entity({ name: 'chat_messages' })
@Index('IDX_chat_messages_threadId_createdAt', ['threadId', 'createdAt'])
export class ChatMessage {
  @PrimaryColumn(idPrimaryColumn())
  id!: string;

  @Column(idColumn())
  threadId!: string;

  @Column({ type: 'varchar', length: 16 })
  role!: ChatRole;

  /** What was said. See the class comment — this is the documented exception. */
  @Column({ type: 'text' })
  content!: string;

  /** The gateway's refusal for a turn that ended badly, or null. */
  @Column({ type: 'varchar', length: 512, nullable: true })
  error!: string | null;

  @Column(timestampColumn())
  createdAt!: Date;

  @ManyToOne(() => ChatThread, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'threadId' })
  thread?: Relation<ChatThread>;
}
