import { randomUUID } from 'node:crypto';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { routerConfig } from '../config.js';
import { ChatMessage, type ChatRole } from '../db/entities/chat-message.entity.js';
import { ChatThread } from '../db/entities/chat-thread.entity.js';

export interface ThreadScope {
  workspaceId: string;
  userId: string;
}

export interface AppendInput extends ThreadScope {
  threadId: string;
  role: ChatRole;
  content: string;
  error?: string | null;
}

/** A thread and the turns it holds, oldest turn first. */
export interface ThreadWithMessages {
  thread: ChatThread;
  messages: ChatMessage[];
}

/**
 * Console-chat transcripts: the one place in this service that stores what a
 * user typed and a model answered.
 *
 * Three rules hold the exception in place, and all three live here rather than in
 * a resolver, so nothing can reach the tables without them:
 *
 *  - **Everything is scoped to `(workspaceId, userId)`.** A thread id alone
 *    resolves to nothing; a member of the right workspace still cannot read
 *    another member's transcript. Every method takes the scope and every query
 *    carries it.
 *  - **The caps are enforced before the insert**, not advised to the browser.
 *    `chatSettings` publishes them so the composer can show a counter, but a
 *    client that ignores them is refused (message length) or pruned (thread and
 *    message counts). That is what keeps a demo surface from becoming free
 *    storage.
 *  - **Deletion is a delete.** No `deletedAt`, no archive. `chat_messages`
 *    cascades from its thread, so one statement removes the transcript.
 */
@Injectable()
export class ChatService {
  constructor(
    @Inject(routerConfig.KEY) private readonly config: ConfigType<typeof routerConfig>,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  private get threads() {
    return this.dataSource.getRepository(ChatThread);
  }

  private get messages() {
    return this.dataSource.getRepository(ChatMessage);
  }

  /** This member's threads in this workspace, most recently used first. */
  async listThreads(scope: ThreadScope): Promise<ChatThread[]> {
    return this.threads.find({
      where: { workspaceId: scope.workspaceId, userId: scope.userId },
      order: { updatedAt: 'DESC' },
      take: this.config.chat.maxThreads,
    });
  }

  /**
   * One thread with its turns, or `NotFoundException`.
   *
   * The scope is in the `where`, so a thread id belonging to another member — or
   * another tenant — is indistinguishable from one that does not exist. That is
   * the intended answer: it leaks nothing about what else is stored.
   */
  async threadWithMessages(scope: ThreadScope, threadId: string): Promise<ThreadWithMessages> {
    const thread = await this.requireThread(scope, threadId);
    const messages = await this.messages.find({
      where: { threadId: thread.id },
      order: { createdAt: 'ASC' },
      take: this.config.chat.maxMessagesPerThread,
    });
    return { thread, messages };
  }

  /**
   * Starts a thread, pruning the member's oldest if they are at the cap.
   *
   * Pruning rather than refusing: a demo surface that answers "you have too many
   * conversations, go and delete one" at the moment someone wants to try a model
   * has failed at the only job it has.
   */
  async createThread(scope: ThreadScope, modelId: string, now: Date = new Date()): Promise<ChatThread> {
    const thread = this.threads.create({
      id: randomUUID(),
      workspaceId: scope.workspaceId,
      userId: scope.userId,
      title: DEFAULT_TITLE,
      modelId,
      createdAt: now,
      updatedAt: now,
    });
    await this.threads.save(thread);
    await this.pruneThreads(scope);
    return thread;
  }

  /** Switching model mid-thread is allowed; comparing two models is the demo. */
  async setThreadModel(scope: ThreadScope, threadId: string, modelId: string): Promise<ChatThread> {
    const thread = await this.requireThread(scope, threadId);
    thread.modelId = modelId;
    return this.threads.save(thread);
  }

  /**
   * Appends one turn.
   *
   * The message cap drops the *oldest* turns rather than refusing the newest: a
   * thread at its limit has to keep working, and the end of a conversation is
   * the part a demo is about.
   */
  async appendMessage(input: AppendInput, now: Date = new Date()): Promise<ChatMessage> {
    const max = this.config.chat.maxMessageChars;
    if (input.content.length > max) {
      throw new BadRequestException(`A chat message may be at most ${max} characters.`);
    }
    const thread = await this.requireThread(input, input.threadId);

    const message = this.messages.create({
      id: randomUUID(),
      threadId: thread.id,
      role: input.role,
      content: input.content,
      error: input.error ?? null,
      createdAt: now,
    });
    await this.messages.save(message);

    // The title is the opening question, taken once. A thread that already has a
    // user turn keeps the title it was given.
    if (input.role === 'user' && thread.title === DEFAULT_TITLE) {
      thread.title = titleFrom(input.content);
    }
    thread.updatedAt = now;
    await this.threads.save(thread);

    await this.pruneMessages(thread.id);
    return message;
  }

  /** Hard delete. Messages go with the thread through the cascade. */
  async deleteThread(scope: ThreadScope, threadId: string): Promise<void> {
    const thread = await this.requireThread(scope, threadId);
    await this.threads.remove(thread);
  }

  private async requireThread(scope: ThreadScope, threadId: string): Promise<ChatThread> {
    const thread = await this.threads.findOne({
      where: { id: threadId, workspaceId: scope.workspaceId, userId: scope.userId },
    });
    if (!thread) {
      throw new NotFoundException('Chat thread not found.');
    }
    return thread;
  }

  /**
   * Drops this member's threads past the cap, oldest first.
   *
   * By id, not by a `LessThan` on the cutoff timestamp. The tidier-looking range
   * delete does not work here: `updatedAt` carries a column transformer, and
   * TypeORM hands the `FindOperator` itself to `to()` in a delete criteria, which
   * then asks a `LessThan` object for `getTime()`. Deleting by id keeps the
   * transformer out of it and is idempotent if two tabs prune at once.
   */
  private async pruneThreads(scope: ThreadScope): Promise<void> {
    const keep = this.config.chat.maxThreads;
    const mine = await this.threads.find({
      where: { workspaceId: scope.workspaceId, userId: scope.userId },
      order: { updatedAt: 'DESC' },
      select: { id: true },
    });
    const stale = mine.slice(keep);
    if (stale.length === 0) {
      return;
    }
    await this.threads.delete({ id: In(stale.map((thread) => thread.id)) });
  }

  private async pruneMessages(threadId: string): Promise<void> {
    const keep = this.config.chat.maxMessagesPerThread;
    const total = await this.messages.count({ where: { threadId } });
    if (total <= keep) {
      return;
    }
    const stale = await this.messages.find({
      where: { threadId },
      order: { createdAt: 'ASC' },
      take: total - keep,
      select: { id: true },
    });
    await this.messages.delete({ id: In(stale.map((message) => message.id)) });
  }
}

/** What a thread is called until its first user message names it. */
export const DEFAULT_TITLE = 'New conversation';

/**
 * The title a thread takes from its opening message: one line, a handful of
 * words. It is a list label, and a paragraph pasted into the composer must not
 * become one. Bounded to the column's 128 characters by construction.
 */
export function titleFrom(content: string): string {
  const oneLine = content.replace(/\s+/g, ' ').trim();
  if (oneLine.length === 0) return DEFAULT_TITLE;
  return oneLine.length <= 48 ? oneLine : `${oneLine.slice(0, 47)}…`;
}
