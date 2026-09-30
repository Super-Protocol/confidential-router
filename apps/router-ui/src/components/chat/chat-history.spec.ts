import { describe, expect, it } from 'vitest';
import { promptMessages, type StoredMessage } from './chat-history';

/**
 * The transcript itself is server-side now, so its rules — titles, the two caps,
 * pruning, hard delete, one member's threads never appearing in another's list —
 * are tested against a real schema in `router-api`'s `app/chat/chat.service.spec.ts`.
 * What is left on this side is the one decision the browser still makes: which of
 * the stored turns go into the next request.
 */

function message(overrides: Partial<StoredMessage> & Pick<StoredMessage, 'role' | 'content'>): StoredMessage {
  return {
    __typename: 'ChatMessage',
    id: overrides.id ?? `m-${overrides.content.slice(0, 8)}`,
    createdAt: overrides.createdAt ?? '2026-09-30T12:00:00.000Z',
    error: overrides.error ?? null,
    ...overrides,
  } as StoredMessage;
}

describe('promptMessages', () => {
  it('maps the stored roles onto what the OpenAI API expects', () => {
    const turns = promptMessages([
      message({ role: 'USER', content: 'question' }),
      message({ role: 'ASSISTANT', content: 'answer' }),
    ]);

    expect(turns).toEqual([
      { role: 'user', content: 'question' },
      { role: 'assistant', content: 'answer' },
    ]);
  });

  it('drops a turn that ended in an error, rather than replaying it as the model’s words', () => {
    // A failed turn stays in the transcript — that is honest — but its content is
    // a partial answer or nothing at all, and feeding it back makes the next
    // answer worse.
    const turns = promptMessages([
      message({ role: 'USER', content: 'question' }),
      message({ role: 'ASSISTANT', content: 'half an ans', error: 'The stream ended early.' }),
      message({ role: 'USER', content: 'again' }),
    ]);

    expect(turns.map((turn) => turn.content)).toEqual(['question', 'again']);
  });

  it('drops an empty turn, which a refused request leaves behind', () => {
    const turns = promptMessages([
      message({ role: 'USER', content: 'question' }),
      message({ role: 'ASSISTANT', content: '' }),
      message({ role: 'ASSISTANT', content: '   ' }),
    ]);

    expect(turns).toHaveLength(1);
  });

  it('keeps the stored order, because a conversation is the order', () => {
    const turns = promptMessages([
      message({ role: 'USER', content: 'first' }),
      message({ role: 'ASSISTANT', content: 'second' }),
      message({ role: 'USER', content: 'third' }),
    ]);

    expect(turns.map((turn) => turn.content)).toEqual(['first', 'second', 'third']);
  });
});
