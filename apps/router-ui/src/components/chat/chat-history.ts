import type { ChatThreadQuery } from '../../generated/graphql';

/**
 * What the chat needs from a transcript that it does not get from the server.
 *
 * The history itself is server-side now (`chat_threads` / `chat_messages`), so
 * there is no store here and no `localStorage`: the thread list and the open
 * conversation are Apollo queries, and the mutations that write them are in
 * `operations.ts`. What remains is the one thing the browser still decides — the
 * turns it puts in the next request — plus the shape of the message that is still
 * arriving and therefore does not exist anywhere yet.
 */

export type ChatRole = 'USER' | 'ASSISTANT';

/** A turn as the server stores it. */
export type StoredMessage = NonNullable<ChatThreadQuery['chatThread']>['messages'][number];

/**
 * The assistant turn that is still streaming.
 *
 * It has no id yet because it is not stored yet: it becomes a row when the stream
 * settles and `appendChatMessage` returns. Keeping it a separate type from
 * {@link StoredMessage} is what stops a half-arrived answer being treated as
 * history.
 */
export interface PendingMessage {
  content: string;
  error?: string;
  /**
   * True when this turn could not be *stored* — the mutation was refused, or no
   * credential could be minted. It is then the only record the user has of what
   * happened, so the screen keeps showing it instead of waiting for a server copy
   * that does not exist.
   */
  unstored?: boolean;
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * The turns sent to the model.
 *
 * Assistant turns that ended in an error are dropped: their content is a partial
 * answer or nothing at all, and replaying it as if the model had said it would
 * make the next answer worse. Empty turns go too — a refused request stores an
 * empty assistant row, and an empty `content` is not a message any provider
 * accepts.
 */
export function promptMessages(messages: readonly StoredMessage[]): ChatTurn[] {
  return messages
    .filter((message) => !message.error && message.content.trim().length > 0)
    .map((message) => ({ role: message.role === 'USER' ? 'user' : 'assistant', content: message.content }));
}
