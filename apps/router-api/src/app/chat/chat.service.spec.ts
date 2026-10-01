import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ENTITIES } from '../db/entities/index.js';
import { Workspace } from '../db/entities/workspace.entity.js';
import { ChatService, DEFAULT_TITLE, TRUNCATED, titleFrom } from './chat.service.js';

/**
 * Against a real SQLite schema rather than mocks: the caps, the pruning and the
 * cascade are all database behaviour, and a stubbed repository would assert the
 * code I wrote rather than the effect it has.
 */

const LIMITS = { enabled: true, maxMessageChars: 20, maxThreads: 3, maxMessagesPerThread: 4, credentialTtl: 1 };

let dataSource: DataSource;
let service: ChatService;

const ALICE = { workspaceId: 'ws-1', userId: 'alice' };
const BOB = { workspaceId: 'ws-1', userId: 'bob' };

beforeEach(async () => {
  dataSource = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: ENTITIES, synchronize: true });
  await dataSource.initialize();
  await dataSource.getRepository(Workspace).save({
    id: 'ws-1',
    name: 'Workspace',
    slug: 'workspace',
    balanceMicros: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as Workspace);
  service = new ChatService({ chat: LIMITS } as never, dataSource);
});

afterEach(async () => {
  await dataSource.destroy();
});

/** Distinct timestamps: the ordering and the pruning are both by `updatedAt`. */
function at(minute: number): Date {
  return new Date(Date.UTC(2026, 8, 30, 12, minute, 0));
}

describe('titleFrom', () => {
  it('takes one line from the opening message', () => {
    expect(titleFrom('  What is\n a TEE? ')).toBe('What is a TEE?');
  });

  it('truncates a pasted paragraph rather than letting it become the label', () => {
    expect(titleFrom('x'.repeat(400))).toHaveLength(48);
  });

  it('falls back when there is nothing to name it after', () => {
    expect(titleFrom('   ')).toBe(DEFAULT_TITLE);
  });
});

describe('a transcript belongs to one member', () => {
  it('does not list another member’s threads, in the same workspace', async () => {
    await service.createThread(ALICE, 'vendor/model', at(1));
    await service.createThread(BOB, 'vendor/model', at(2));

    expect(await service.listThreads(ALICE)).toHaveLength(1);
    expect(await service.listThreads(BOB)).toHaveLength(1);
  });

  it('answers "not found" for a sibling’s thread id, leaking nothing about it', async () => {
    // The same answer as a thread that does not exist, on purpose: a different
    // error would confirm that something is stored under that id.
    const alices = await service.createThread(ALICE, 'vendor/model', at(1));

    await expect(service.threadWithMessages(BOB, alices.id)).rejects.toThrow(NotFoundException);
    await expect(service.deleteThread(BOB, alices.id)).rejects.toThrow(NotFoundException);
    await expect(
      service.appendMessage({ ...BOB, threadId: alices.id, role: 'user', content: 'hello' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('refuses a thread id from another workspace', async () => {
    const thread = await service.createThread(ALICE, 'vendor/model', at(1));

    await expect(service.threadWithMessages({ workspaceId: 'ws-other', userId: 'alice' }, thread.id)).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('appending a turn', () => {
  it('names the thread after the first user message and no later one', async () => {
    const thread = await service.createThread(ALICE, 'vendor/model', at(1));

    await service.appendMessage({ ...ALICE, threadId: thread.id, role: 'user', content: 'First' }, at(2));
    await service.appendMessage({ ...ALICE, threadId: thread.id, role: 'assistant', content: 'Answer' }, at(3));
    await service.appendMessage({ ...ALICE, threadId: thread.id, role: 'user', content: 'Second' }, at(4));

    expect((await service.threadWithMessages(ALICE, thread.id)).thread.title).toBe('First');
  });

  it('keeps a failed turn, with what arrived and why it stopped', async () => {
    const thread = await service.createThread(ALICE, 'vendor/model', at(1));

    await service.appendMessage(
      { ...ALICE, threadId: thread.id, role: 'assistant', content: 'half an ans', error: 'The stream ended early.' },
      at(2),
    );

    const [message] = (await service.threadWithMessages(ALICE, thread.id)).messages;
    expect(message?.content).toBe('half an ans');
    expect(message?.error).toBe('The stream ended early.');
  });

  it('refuses a question past the configured ceiling, before any inference is paid for', async () => {
    const thread = await service.createThread(ALICE, 'vendor/model', at(1));

    await expect(
      service.appendMessage({ ...ALICE, threadId: thread.id, role: 'user', content: 'x'.repeat(21) }),
    ).rejects.toThrow(BadRequestException);
    expect((await service.threadWithMessages(ALICE, thread.id)).messages).toHaveLength(0);
  });

  /*
   * The same ceiling, the other role, and deliberately not the same act
   * (SUP-187). An assistant turn only arrives here after the answer has been
   * streamed to the reader and billed, so refusing it would throw away
   * something already bought and leave the question unanswered in the
   * transcript. It is kept and cut, and the cut is on the record.
   */
  it('keeps an answer past the ceiling, cut short and marked', async () => {
    const thread = await service.createThread(ALICE, 'vendor/model', at(1));

    await service.appendMessage({ ...ALICE, threadId: thread.id, role: 'assistant', content: 'a'.repeat(25) }, at(2));

    const [message] = (await service.threadWithMessages(ALICE, thread.id)).messages;
    expect(message?.content).toBe('a'.repeat(20));
    expect(message?.error).toBe(TRUNCATED);
  });

  it('keeps the gateway’s own refusal alongside the truncation note', async () => {
    const thread = await service.createThread(ALICE, 'vendor/model', at(1));

    await service.appendMessage(
      {
        ...ALICE,
        threadId: thread.id,
        role: 'assistant',
        content: 'a'.repeat(25),
        error: 'The stream ended early.',
      },
      at(2),
    );

    const [message] = (await service.threadWithMessages(ALICE, thread.id)).messages;
    expect(message?.error).toBe(`The stream ended early. ${TRUNCATED}`);
  });

  it('leaves an answer that fits exactly alone', async () => {
    const thread = await service.createThread(ALICE, 'vendor/model', at(1));

    await service.appendMessage({ ...ALICE, threadId: thread.id, role: 'assistant', content: 'a'.repeat(20) }, at(2));

    const [message] = (await service.threadWithMessages(ALICE, thread.id)).messages;
    expect(message?.content).toBe('a'.repeat(20));
    expect(message?.error).toBeNull();
  });

  it('moves the thread it touched to the top of the list', async () => {
    const first = await service.createThread(ALICE, 'vendor/model', at(1));
    await service.createThread(ALICE, 'vendor/model', at(2));

    await service.appendMessage({ ...ALICE, threadId: first.id, role: 'user', content: 'later' }, at(9));

    expect((await service.listThreads(ALICE))[0]?.id).toBe(first.id);
  });

  it('drops the oldest turns at the cap, so a thread at its limit keeps working', async () => {
    const thread = await service.createThread(ALICE, 'vendor/model', at(0));
    for (let index = 1; index <= 6; index += 1) {
      await service.appendMessage({ ...ALICE, threadId: thread.id, role: 'user', content: `q${index}` }, at(index));
    }

    const { messages } = await service.threadWithMessages(ALICE, thread.id);
    expect(messages.map((message) => message.content)).toEqual(['q3', 'q4', 'q5', 'q6']);
  });
});

describe('the thread cap', () => {
  it('prunes the member’s oldest rather than refusing a new conversation', async () => {
    // Answering "you have too many conversations, go and delete one" at the moment
    // someone wants to try a model would fail at the only job this screen has.
    for (const minute of [1, 2, 3]) {
      await service.createThread(ALICE, 'vendor/model', at(minute));
    }
    const newest = await service.createThread(ALICE, 'vendor/model', at(4));

    const threads = await service.listThreads(ALICE);
    expect(threads).toHaveLength(3);
    expect(threads[0]?.id).toBe(newest.id);
  });

  it('prunes only the member who created one, never a sibling’s', async () => {
    const bobs = await service.createThread(BOB, 'vendor/model', at(0));
    for (const minute of [1, 2, 3, 4]) {
      await service.createThread(ALICE, 'vendor/model', at(minute));
    }

    expect((await service.listThreads(BOB)).map((thread) => thread.id)).toEqual([bobs.id]);
  });
});

describe('deleting a thread', () => {
  it('takes its turns with it, leaving nothing behind', async () => {
    const thread = await service.createThread(ALICE, 'vendor/model', at(1));
    await service.appendMessage({ ...ALICE, threadId: thread.id, role: 'user', content: 'delete me' }, at(2));

    await service.deleteThread(ALICE, thread.id);

    expect(await service.listThreads(ALICE)).toEqual([]);
    // The cascade, asserted against the table rather than the API that hid it.
    expect(await dataSource.getRepository('chat_messages').count()).toBe(0);
  });
});

describe('switching model mid-thread', () => {
  it('changes this conversation, because comparing two models is the demo', async () => {
    const thread = await service.createThread(ALICE, 'vendor/a', at(1));

    await service.setThreadModel(ALICE, thread.id, 'vendor/b');

    expect((await service.threadWithMessages(ALICE, thread.id)).thread.modelId).toBe('vendor/b');
  });
});
