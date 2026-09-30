import { beforeEach, describe, expect, it } from 'vitest';
import {
  addThread,
  appendMessage,
  type ChatHistory,
  type ChatMessage,
  deleteThread,
  EMPTY_HISTORY,
  historyStorageKey,
  localHistoryStore,
  newThread,
  parseHistory,
  promptMessages,
  replaceMessage,
  titleFrom,
} from './chat-history';

const LIMITS = { maxThreads: 3, maxMessagesPerThread: 4 };

interface MessageInput {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  at?: string;
}

function message({ id, role, content, at = '2026-09-30T10:00:00.000Z' }: MessageInput): ChatMessage {
  return { id, role, content, createdAt: at };
}

function historyWith(threadId: string, messages: ChatMessage[]): ChatHistory {
  return {
    version: 1,
    threads: [
      {
        id: threadId,
        title: 'New conversation',
        modelId: 'vendor/model',
        createdAt: '2026-09-30T10:00:00.000Z',
        updatedAt: '2026-09-30T10:00:00.000Z',
        messages,
      },
    ],
  };
}

describe('titleFrom', () => {
  it('takes the first user message, collapsed to one line', () => {
    expect(titleFrom('  What is\n a TEE? ')).toBe('What is a TEE?');
  });

  it('truncates a pasted paragraph rather than letting it become the label', () => {
    const title = titleFrom('x'.repeat(200));
    expect(title).toHaveLength(48);
    expect(title.endsWith('…')).toBe(true);
  });

  it('falls back for an empty message', () => {
    expect(titleFrom('   ')).toBe('New conversation');
  });
});

describe('appendMessage', () => {
  it('titles the thread from its first user message and no later one', () => {
    let history = historyWith('t1', []);
    history = appendMessage(
      history,
      't1',
      message({ id: 'm1', role: 'user', content: 'First question', at: '2026-09-30T10:01:00Z' }),
      LIMITS,
    );
    history = appendMessage(
      history,
      't1',
      message({ id: 'm2', role: 'assistant', content: 'An answer', at: '2026-09-30T10:02:00Z' }),
      LIMITS,
    );
    history = appendMessage(
      history,
      't1',
      message({ id: 'm3', role: 'user', content: 'Second question', at: '2026-09-30T10:03:00Z' }),
      LIMITS,
    );

    expect(history.threads[0]?.title).toBe('First question');
  });

  it('drops the oldest messages at the cap, so a thread at its limit keeps working', () => {
    let history = historyWith('t1', []);
    for (let index = 1; index <= 6; index += 1) {
      history = appendMessage(
        history,
        't1',
        message({ id: `m${index}`, role: 'user', content: `q${index}`, at: `2026-09-30T10:0${index}:00.000Z` }),
        LIMITS,
      );
    }

    expect(history.threads[0]?.messages.map((entry) => entry.id)).toEqual(['m3', 'm4', 'm5', 'm6']);
  });

  it('moves the thread it touched to the top of the list', () => {
    const history: ChatHistory = {
      version: 1,
      threads: [
        { ...historyWith('a', []).threads[0], id: 'a', updatedAt: '2026-09-30T12:00:00.000Z' },
        { ...historyWith('b', []).threads[0], id: 'b', updatedAt: '2026-09-30T09:00:00.000Z' },
      ],
    };

    const next = appendMessage(
      history,
      'b',
      message({ id: 'm1', role: 'user', content: 'hello', at: '2026-09-30T13:00:00.000Z' }),
      LIMITS,
    );

    expect(next.threads.map((thread) => thread.id)).toEqual(['b', 'a']);
  });
});

describe('addThread', () => {
  it('evicts the least recently updated thread at the workspace cap', () => {
    let history = EMPTY_HISTORY;
    for (const [index, at] of ['10:00', '11:00', '12:00'].entries()) {
      history = addThread(
        history,
        { ...newThread('vendor/model'), id: `t${index}`, updatedAt: `2026-09-30T${at}:00.000Z` },
        LIMITS,
      );
    }

    history = addThread(
      history,
      { ...newThread('vendor/model'), id: 'newest', updatedAt: '2026-09-30T13:00:00.000Z' },
      LIMITS,
    );

    expect(history.threads).toHaveLength(3);
    expect(history.threads.map((thread) => thread.id)).toEqual(['newest', 't2', 't1']);
  });
});

describe('deleteThread', () => {
  it('removes the thread outright, leaving nothing behind', () => {
    const history = addThread(historyWith('keep', []), { ...newThread('vendor/model'), id: 'drop' }, LIMITS);

    const next = deleteThread(history, 'drop');

    expect(next.threads.map((thread) => thread.id)).toEqual(['keep']);
    expect(JSON.stringify(next)).not.toContain('drop');
  });
});

describe('promptMessages', () => {
  it('drops empty and errored turns, so a failed answer is not replayed as the model’s words', () => {
    const thread = historyWith('t1', [
      message({ id: 'm1', role: 'user', content: 'question', at: '2026-09-30T10:00:00Z' }),
      {
        ...message({ id: 'm2', role: 'assistant', content: 'half an ans', at: '2026-09-30T10:01:00Z' }),
        error: 'The stream ended early.',
      },
      message({ id: 'm3', role: 'user', content: 'again', at: '2026-09-30T10:02:00Z' }),
      message({ id: 'm4', role: 'assistant', content: '', at: '2026-09-30T10:03:00Z' }),
    ]).threads[0];

    expect(promptMessages(thread)).toEqual([
      { role: 'user', content: 'question' },
      { role: 'user', content: 'again' },
    ]);
  });
});

describe('replaceMessage', () => {
  it('patches one message of one thread and touches nothing else', () => {
    const history = historyWith('t1', [
      message({ id: 'm1', role: 'assistant', content: 'partial', at: '2026-09-30T10:00:00Z' }),
    ]);

    const next = replaceMessage(history, 't1', 'm1', { content: 'complete' });

    expect(next.threads[0]?.messages[0]?.content).toBe('complete');
    expect(next.threads[0]?.messages[0]?.error).toBeUndefined();
  });
});

describe('parseHistory', () => {
  it('reads nothing as an empty history', () => {
    expect(parseHistory(null, LIMITS)).toEqual(EMPTY_HISTORY);
  });

  it('reads a hand-edited or stale value as an empty history rather than throwing', () => {
    // This runs on the first render of the screen: a bad key must not be able to
    // make the chat unreachable.
    expect(parseHistory('not json', LIMITS)).toEqual(EMPTY_HISTORY);
    expect(parseHistory('{"version":99,"threads":[]}', LIMITS)).toEqual(EMPTY_HISTORY);
    expect(parseHistory('{"version":1}', LIMITS)).toEqual(EMPTY_HISTORY);
  });

  it('discards entries that are not threads and enforces both caps on load', () => {
    const stored = JSON.stringify({
      version: 1,
      threads: [
        'nonsense',
        { id: 'a', title: 'A', modelId: 'm', createdAt: 'x', updatedAt: '2026-09-30T12:00:00.000Z', messages: [] },
        { id: 'b', title: 'B', modelId: 'm', createdAt: 'x', updatedAt: '2026-09-30T11:00:00.000Z', messages: [] },
        { id: 'c', title: 'C', modelId: 'm', createdAt: 'x', updatedAt: '2026-09-30T10:00:00.000Z', messages: [] },
        { id: 'd', title: 'D', modelId: 'm', createdAt: 'x', updatedAt: '2026-09-30T09:00:00.000Z', messages: [] },
      ],
    });

    const history = parseHistory(stored, LIMITS);

    expect(history.threads.map((thread) => thread.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('localHistoryStore', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('keeps one key per workspace, so two tenants in one browser never share a transcript', () => {
    localHistoryStore('ws-1', LIMITS).save(historyWith('t1', []));

    expect(localStorage.getItem(historyStorageKey('ws-1'))).toContain('t1');
    expect(localHistoryStore('ws-2', LIMITS).load()).toEqual(EMPTY_HISTORY);
  });

  it('round-trips a history', () => {
    const store = localHistoryStore('ws-1', LIMITS);
    store.save(
      historyWith('t1', [message({ id: 'm1', role: 'user', content: 'hello', at: '2026-09-30T10:00:00.000Z' })]),
    );

    expect(store.load().threads[0]?.messages[0]?.content).toBe('hello');
  });

  it('swallows a storage failure rather than losing the turn with it', () => {
    const store = localHistoryStore('ws-1', LIMITS);
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    try {
      expect(() => store.save(historyWith('t1', []))).not.toThrow();
    } finally {
      Storage.prototype.setItem = setItem;
    }
  });
});
