/**
 * The chat's conversation history, in the visitor's own browser.
 *
 * This is where it lives *today*, and the screen says so: server-side history
 * waits on SUP-179, which is establishing whether a tenant PVC on the in-TEE
 * state disk survives a node reboot. Until that has an answer, storing threads
 * on the deployment would be a durability promise nobody has made — so the
 * history is local, the disclosure copy says local, and the API's
 * `chatSettings.historyStorage` is what the screen reads to decide which of
 * those two stories it is allowed to tell.
 *
 * Everything here is a pure function over a `ChatHistory` value plus one thin
 * localStorage adapter at the bottom, so the caps and the pruning are testable
 * without a browser. A quota error is swallowed on purpose: losing the last turn
 * of a demo transcript must not take the screen down with it.
 */

export type ChatRole = 'user' | 'assistant';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
  /** Present on assistant turns that ended badly, so the thread shows what happened. */
  error?: string;
}

export interface ChatThread {
  id: string;
  /** Derived from the first user message; never typed by the user. */
  title: string;
  modelId: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
}

export interface ChatHistory {
  version: 1;
  threads: ChatThread[];
}

export interface HistoryLimits {
  maxThreads: number;
  maxMessagesPerThread: number;
}

export const EMPTY_HISTORY: ChatHistory = { version: 1, threads: [] };

/** One key per workspace: two workspaces in one browser must not share a transcript. */
export function historyStorageKey(workspaceId: string): string {
  return `router-console.chat.v1.${workspaceId}`;
}

export function newThread(modelId: string, now: Date = new Date()): ChatThread {
  const createdAt = now.toISOString();
  return {
    id: messageId(now),
    title: 'New conversation',
    modelId,
    createdAt,
    updatedAt: createdAt,
    messages: [],
  };
}

export function messageId(now: Date = new Date()): string {
  // `randomUUID` needs a secure context, which a developer's `http://localhost`
  // console is not; the id only has to be unique within one browser's history.
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `${now.getTime().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * The title a thread takes from its first user message.
 *
 * Trimmed to one line and a handful of words: it is a list label, and a
 * paragraph pasted into the composer must not become one.
 */
export function titleFrom(content: string): string {
  const oneLine = content.replace(/\s+/g, ' ').trim();
  if (oneLine.length === 0) return 'New conversation';
  return oneLine.length <= 48 ? oneLine : `${oneLine.slice(0, 47)}…`;
}

/**
 * Adds a message, prunes the thread to its cap, and moves the thread to the top.
 *
 * The cap drops the *oldest* messages rather than refusing the newest: a thread
 * at its limit has to keep working, and the end of a conversation is the part a
 * demo is about. The system has no prompt of its own to protect at the front.
 */
// biome-ignore lint/complexity/useMaxParams: reducer shape — (state, where, what, limits) is the order every call site reads in.
export function appendMessage(
  history: ChatHistory,
  threadId: string,
  message: ChatMessage,
  limits: HistoryLimits,
): ChatHistory {
  const threads = history.threads.map((thread) => {
    if (thread.id !== threadId) return thread;
    const messages = [...thread.messages, message].slice(-limits.maxMessagesPerThread);
    const title =
      thread.messages.some((existing) => existing.role === 'user') || message.role !== 'user'
        ? thread.title
        : titleFrom(message.content);
    return { ...thread, messages, title, updatedAt: message.createdAt };
  });
  return { ...history, threads: sortByRecency(threads) };
}

/** Replaces the content of one message — the streaming assistant turn. */
// biome-ignore lint/complexity/useMaxParams: the same reducer shape as `appendMessage`, with the patch last.
export function replaceMessage(
  history: ChatHistory,
  threadId: string,
  messageId: string,
  patch: Partial<Pick<ChatMessage, 'content' | 'error'>>,
): ChatHistory {
  return {
    ...history,
    threads: history.threads.map((thread) =>
      thread.id === threadId
        ? {
            ...thread,
            messages: thread.messages.map((message) => (message.id === messageId ? { ...message, ...patch } : message)),
          }
        : thread,
    ),
  };
}

/**
 * Adds a thread, evicting the least recently updated one when the workspace is at
 * its cap — which is what stops a demo surface becoming a free storage service.
 */
export function addThread(history: ChatHistory, thread: ChatThread, limits: HistoryLimits): ChatHistory {
  const threads = sortByRecency([thread, ...history.threads.filter((existing) => existing.id !== thread.id)]);
  return { ...history, threads: threads.slice(0, Math.max(1, limits.maxThreads)) };
}

/** Hard delete. There is no archive, no tombstone and nothing kept for later. */
export function deleteThread(history: ChatHistory, threadId: string): ChatHistory {
  return { ...history, threads: history.threads.filter((thread) => thread.id !== threadId) };
}

export function findThread(history: ChatHistory, threadId: string | null): ChatThread | null {
  if (!threadId) return null;
  return history.threads.find((thread) => thread.id === threadId) ?? null;
}

/**
 * The turns sent to the model.
 *
 * Assistant turns that ended in an error are dropped: their content is a partial
 * answer or nothing at all, and replaying it as if the model had said it would
 * make the next answer worse.
 */
export function promptMessages(thread: ChatThread): { role: ChatRole; content: string }[] {
  return thread.messages
    .filter((message) => !message.error && message.content.trim().length > 0)
    .map((message) => ({ role: message.role, content: message.content }));
}

function sortByRecency(threads: ChatThread[]): ChatThread[] {
  return [...threads].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

/**
 * Reads whatever is in storage, accepting nothing it does not recognise.
 *
 * A stale or hand-edited value reads as "no history" rather than throwing: this
 * runs on the first render of the screen, and a bad key must not be able to make
 * the chat unreachable.
 */
export function parseHistory(raw: string | null, limits: HistoryLimits): ChatHistory {
  if (!raw) return EMPTY_HISTORY;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return EMPTY_HISTORY;
  }
  if (!value || typeof value !== 'object' || (value as { version?: unknown }).version !== 1) {
    return EMPTY_HISTORY;
  }
  const threads = (value as { threads?: unknown }).threads;
  if (!Array.isArray(threads)) return EMPTY_HISTORY;

  const parsed = threads.filter(isThread).map((thread) => ({
    ...thread,
    messages: thread.messages.filter(isMessage).slice(-limits.maxMessagesPerThread),
  }));

  return { version: 1, threads: sortByRecency(parsed).slice(0, Math.max(1, limits.maxThreads)) };
}

function isThread(value: unknown): value is ChatThread {
  if (!value || typeof value !== 'object') return false;
  const thread = value as Partial<ChatThread>;
  return (
    typeof thread.id === 'string' &&
    typeof thread.title === 'string' &&
    typeof thread.modelId === 'string' &&
    typeof thread.createdAt === 'string' &&
    typeof thread.updatedAt === 'string' &&
    Array.isArray(thread.messages)
  );
}

function isMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<ChatMessage>;
  return (
    typeof message.id === 'string' &&
    (message.role === 'user' || message.role === 'assistant') &&
    typeof message.content === 'string' &&
    typeof message.createdAt === 'string'
  );
}

/** The storage adapter. Separate so every rule above is testable without a DOM. */
export interface HistoryStore {
  load(): ChatHistory;
  save(history: ChatHistory): void;
  clear(): void;
}

export function localHistoryStore(workspaceId: string, limits: HistoryLimits): HistoryStore {
  const key = historyStorageKey(workspaceId);
  const storage = (): Storage | null => {
    try {
      return globalThis.localStorage ?? null;
    } catch {
      // Blocked by a browser setting. The chat still works for this sitting.
      return null;
    }
  };

  return {
    load() {
      try {
        return parseHistory(storage()?.getItem(key) ?? null, limits);
      } catch {
        return EMPTY_HISTORY;
      }
    },
    save(history) {
      try {
        storage()?.setItem(key, JSON.stringify(history));
      } catch {
        // Quota, or storage disabled. Losing the transcript must not lose the turn.
      }
    },
    clear() {
      try {
        storage()?.removeItem(key);
      } catch {
        // Nothing to do; the caller has already dropped it from memory.
      }
    },
  };
}
