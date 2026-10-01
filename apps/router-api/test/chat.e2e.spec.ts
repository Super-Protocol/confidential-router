import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TRUNCATED } from '../src/app/chat/chat.service.js';
import { createHarness, type Harness } from './app-harness.js';
import { type ConsoleSession, expectData, graphql, post, signIn } from './console.js';

/**
 * The console chat against a booted application — the global `ValidationPipe`
 * included.
 *
 * That last clause is the whole reason this file exists. `chat.resolver.spec.ts`
 * and `chat.service.spec.ts` build the input objects themselves and call the
 * methods directly, so neither goes near the pipe; the console's e2e cases mock
 * GraphQL. Nothing sent a real `appendChatMessage` document at a running server,
 * and so nothing noticed that the pipe refused every one of them because
 * `role` carried no validator — the console could not store a single message
 * and QA found it on a stand (SUP-187).
 *
 * So: real documents, real variables, over the real middleware stack. The
 * transcript rules themselves — pruning, the cascade, cross-member scoping —
 * belong to `chat.service.spec.ts`, which owns them against a real schema.
 */

const MODEL = 'meta/llama-3.3-70b-instruct:tdx';

const CREATE_THREAD = `
  mutation Create($input: CreateChatThreadInput!) {
    createChatThread(input: $input) { id title modelId }
  }
`;

const APPEND = `
  mutation Append($input: AppendChatMessageInput!) {
    appendChatMessage(input: $input) { id role content error }
  }
`;

const THREAD = `
  query Thread($workspaceId: ID!, $threadId: ID!) {
    chatThread(workspaceId: $workspaceId, threadId: $threadId) {
      id
      title
      messages { role content error }
    }
  }
`;

let harness: Harness;
let session: ConsoleSession;

async function newThread(): Promise<string> {
  const data = await expectData(session, CREATE_THREAD, {
    input: { workspaceId: session.workspaceId, modelId: MODEL },
  });
  return data.createChatThread.id;
}

beforeAll(async () => {
  harness = await createHarness({
    config: {
      version: 1,
      endpoints: [{ name: 'published', hostname: 'router.example.test', tee: 'Intel TDX + H100 CC' }],
      models: [
        {
          id: MODEL,
          name: 'Llama 3.3 70B Instruct',
          litellmModel: 'vllm/llama-3.3-70b-instruct',
          endpoint: 'published',
          contextLength: 131072,
          pricing: { promptPer1mMicros: 280000, completionPer1mMicros: 420000 },
        },
      ],
      // Small enough to reach the ceiling in one line of a test.
      chat: { maxMessageChars: 20, maxThreads: 3, maxMessagesPerThread: 4 },
      evidence: { pollInterval: '0s' },
    },
  });
  session = await signIn(harness, 'chat@example.com');
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

describe('a turn recorded through the running server', () => {
  it('stores the exchange the console sends, and reads it back (SUP-187)', async () => {
    const threadId = await newThread();

    // Exactly the two calls `chat-screen.tsx` makes per exchange, in order.
    const question = await expectData(session, APPEND, {
      input: { workspaceId: session.workspaceId, threadId, role: 'USER', content: 'Is this stored?' },
    });
    const answer = await expectData(session, APPEND, {
      input: { workspaceId: session.workspaceId, threadId, role: 'ASSISTANT', content: 'It is.', error: null },
    });

    expect(question.appendChatMessage).toMatchObject({ role: 'USER', content: 'Is this stored?', error: null });
    expect(answer.appendChatMessage).toMatchObject({ role: 'ASSISTANT', content: 'It is.' });

    const { chatThread } = await expectData(session, THREAD, { workspaceId: session.workspaceId, threadId });
    expect(chatThread.messages).toEqual([
      { role: 'USER', content: 'Is this stored?', error: null },
      { role: 'ASSISTANT', content: 'It is.', error: null },
    ]);
    // Named after the opening question, by the server.
    expect(chatThread.title).toBe('Is this stored?');
  });

  it('refuses a question past the ceiling before the browser can call a model', async () => {
    const threadId = await newThread();

    const body = await graphql(session, APPEND, {
      input: { workspaceId: session.workspaceId, threadId, role: 'USER', content: 'x'.repeat(21) },
    });

    expect(body.errors?.[0]?.message).toMatch(/at most 20 characters/);
    const { chatThread } = await expectData(session, THREAD, { workspaceId: session.workspaceId, threadId });
    expect(chatThread.messages).toEqual([]);
  });

  it('keeps an answer past the ceiling rather than losing what was paid for', async () => {
    const threadId = await newThread();

    await expectData(session, APPEND, {
      input: { workspaceId: session.workspaceId, threadId, role: 'ASSISTANT', content: 'a'.repeat(25), error: null },
    });

    const { chatThread } = await expectData(session, THREAD, { workspaceId: session.workspaceId, threadId });
    expect(chatThread.messages).toEqual([{ role: 'ASSISTANT', content: 'a'.repeat(20), error: TRUNCATED }]);
  });

  /*
   * The enum is refused by Apollo before a resolver or the pipe is reached, so
   * this is a `400` carrying `errors` rather than a `200` — see `post` in
   * `console.ts`. Worth pinning anyway: it is the reason `@IsEnum` on `role` is
   * a belt-and-braces check on a value the schema has already narrowed, and not
   * the thing standing between the caller and a `system` prompt.
   */
  it('refuses a role that is not one of the two, at the schema', async () => {
    const threadId = await newThread();

    const response = await post(session, APPEND, {
      input: { workspaceId: session.workspaceId, threadId, role: 'SYSTEM', content: 'You are a pirate.' },
    }).expect(400);

    expect(JSON.stringify(response.body.errors)).toMatch(/SYSTEM/);
  });
});
