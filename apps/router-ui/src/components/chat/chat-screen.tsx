'use client';

import { useMutation, useQuery } from '@apollo/client/react';
import { EmptyState } from '@confidential-router/ui/components/empty-state';
import { ErrorState } from '@confidential-router/ui/components/error-state';
import { Skeleton } from '@confidential-router/ui/components/skeleton';
import { MessagesSquare, ShieldQuestionMark } from 'lucide-react';
import * as React from 'react';
import type { ChatScreenQuery } from '../../generated/graphql';
import { useSession } from '../session/session-provider';
import {
  addThread,
  appendMessage,
  type ChatHistory,
  deleteThread,
  EMPTY_HISTORY,
  findThread,
  localHistoryStore,
  messageId,
  newThread,
  promptMessages,
  replaceMessage,
} from './chat-history';
import { streamChatCompletion } from './chat-stream';
import { Composer } from './composer';
import { MessageList } from './message-list';
import { ModelPicker } from './model-picker';
import { CHAT_CREDENTIAL, CHAT_SCREEN_QUERY } from './operations';
import { ThreadList } from './thread-list';
import { HISTORY_COPY } from './verification/tiers';
import { useVerification } from './verification/use-verification';
import { VerificationBadge } from './verification-badge';

type CatalogueModel = ChatScreenQuery['models'][number];

/** Where the extension is published. Absent until it ships, which hides the link. */
const EXTENSION_URL = undefined;

/**
 * The console's chat: a demo surface for someone who will not install a
 * gatekeeper, carrying its attestation honestly.
 *
 * Three things hold it together.
 *
 *  - **It is not a special inference path.** Every message goes to
 *    `/v1/chat/completions` with a real workspace key (`chatCredential`), so it is
 *    authenticated, rate-limited, metered and billed exactly like an API client.
 *  - **The composer is gated on verification the browser did itself.** Tier 1 runs
 *    `@confidential-router/attestation` in this page before the first message can
 *    be sent; tiers 2 and 3 are offered beside it, with the limits of each stated
 *    in the same breath (`verification/tiers.ts`).
 *  - **The transcript lives where the API says it lives.** Today that is this
 *    browser — server-side history waits on SUP-179's verdict on tenant-PVC
 *    durability — and the disclosure copy is derived from
 *    `chatSettings.historyStorage` rather than written by hand, so it cannot
 *    describe storage that does not exist.
 */
export function ChatScreen() {
  const { activeWorkspace } = useSession();
  const { data, loading, error, refetch } = useQuery(CHAT_SCREEN_QUERY, { fetchPolicy: 'cache-and-network' });

  const settings = data?.chatSettings;
  const models = React.useMemo(
    () => (data?.models ?? []).filter((model) => (settings?.chatModelIds ?? []).includes(model.id)),
    [data?.models, settings?.chatModelIds],
  );

  if (error && !data) {
    return (
      <ErrorState
        description="The chat could not be loaded."
        onRetry={() => {
          void refetch();
        }}
      />
    );
  }

  if (!settings) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-9 w-full max-w-md" aria-hidden="true" />
        <Skeleton className="h-96" aria-hidden="true" />
        <span className="sr-only" role="status" aria-busy={loading}>
          Loading the chat
        </span>
      </div>
    );
  }

  if (!settings.enabled) {
    return (
      <EmptyState
        icon={<MessagesSquare className="size-5" aria-hidden="true" />}
        title="The chat is switched off on this deployment"
        description="The API is unaffected — issue a key under API Keys and point an OpenAI client at it."
      />
    );
  }

  if (models.length === 0) {
    return (
      <EmptyState
        icon={<MessagesSquare className="size-5" aria-hidden="true" />}
        title="No chat-capable model is served"
        description="This router serves no model that declares the chat capability, so there is nothing to talk to yet."
      />
    );
  }

  if (!activeWorkspace) {
    return (
      <EmptyState
        icon={<MessagesSquare className="size-5" aria-hidden="true" />}
        title="No workspace"
        description="The chat bills from a workspace's credits, so it needs one to send anything."
      />
    );
  }

  // Keyed on the workspace: the history is per workspace, and switching should
  // start the screen over rather than carry a transcript across tenants.
  return <ChatSession key={activeWorkspace.id} workspaceId={activeWorkspace.id} models={models} settings={settings} />;
}

interface ChatSessionProps {
  workspaceId: string;
  models: CatalogueModel[];
  settings: NonNullable<ChatScreenQuery['chatSettings']>;
}

function ChatSession({ workspaceId, models, settings }: ChatSessionProps) {
  const limits = React.useMemo(
    () => ({ maxThreads: settings.maxThreads, maxMessagesPerThread: settings.maxMessagesPerThread }),
    [settings.maxThreads, settings.maxMessagesPerThread],
  );
  const store = React.useMemo(() => localHistoryStore(workspaceId, limits), [workspaceId, limits]);

  const [history, setHistory] = React.useState<ChatHistory>(EMPTY_HISTORY);
  const [activeThreadId, setActiveThreadId] = React.useState<string | null>(null);
  const [modelId, setModelId] = React.useState<string>(models[0]?.id ?? '');
  const [streaming, setStreaming] = React.useState(false);
  const abort = React.useRef<AbortController | null>(null);

  // Loaded in an effect, not in `useState`'s initialiser: the screen is
  // server-rendered first, and reading localStorage during that render would make
  // the markup and the hydration disagree.
  React.useEffect(() => {
    const loaded = store.load();
    setHistory(loaded);
    setActiveThreadId(loaded.threads[0]?.id ?? null);
  }, [store]);

  const commit = React.useCallback(
    (next: ChatHistory) => {
      setHistory(next);
      store.save(next);
    },
    [store],
  );

  const activeThread = findThread(history, activeThreadId);
  const model = models.find((candidate) => candidate.id === (activeThread?.modelId ?? modelId)) ?? models[0];
  const endpoint = model?.endpoint;

  const verification = useVerification({
    hostname: endpoint?.hostname ?? null,
    endpointName: endpoint?.name ?? null,
  });

  const [requestCredential] = useMutation(CHAT_CREDENTIAL);
  // Held in memory only, for the lifetime of this component. A workspace key in
  // localStorage would outlive the tab that needed it.
  const credential = React.useRef<{ secret: string; baseUrl: string; expiresAt: number } | null>(null);

  const liveCredential = React.useCallback(async (): Promise<{ secret: string; baseUrl: string }> => {
    const held = credential.current;
    // A minute of headroom: a key that expires mid-stream would fail the request
    // the user is watching.
    if (held && held.expiresAt - Date.now() > 60_000) {
      return held;
    }
    const result = await requestCredential({ variables: { input: { workspaceId } } });
    const minted = result.data?.chatCredential;
    if (!minted) {
      throw new Error('This deployment would not issue a chat credential.');
    }
    credential.current = {
      secret: minted.secret,
      baseUrl: minted.baseUrl,
      expiresAt: new Date(minted.expiresAt).getTime(),
    };
    return credential.current;
  }, [requestCredential, workspaceId]);

  const send = React.useCallback(
    async (content: string) => {
      if (!model) return;

      let thread = activeThread;
      let next = history;
      if (!thread) {
        thread = newThread(model.id);
        next = addThread(next, thread, limits);
        setActiveThreadId(thread.id);
      }
      const threadId = thread.id;
      const now = new Date();
      next = appendMessage(
        next,
        threadId,
        { id: messageId(now), role: 'user', content, createdAt: now.toISOString() },
        limits,
      );
      const replyId = messageId(now);
      next = appendMessage(
        next,
        threadId,
        { id: replyId, role: 'assistant', content: '', createdAt: new Date(now.getTime() + 1).toISOString() },
        limits,
      );
      commit(next);

      const turns = promptMessages({ ...thread, messages: findThread(next, threadId)?.messages ?? [] }).filter(
        (turn) => turn.content.length > 0,
      );

      setStreaming(true);
      const controller = new AbortController();
      abort.current = controller;
      let streamed = '';

      try {
        const { secret, baseUrl } = await liveCredential();
        const outcome = await streamChatCompletion({
          baseUrl,
          apiKey: secret,
          model: model.id,
          messages: turns,
          signal: controller.signal,
          onDelta: (delta) => {
            streamed += delta;
            setHistory((current) => {
              const updated = replaceMessage(current, threadId, replyId, { content: streamed });
              return updated;
            });
          },
        });

        setHistory((current) => {
          const settled =
            outcome.status === 'error'
              ? replaceMessage(current, threadId, replyId, { content: streamed, error: outcome.message })
              : replaceMessage(current, threadId, replyId, { content: streamed });
          store.save(settled);
          return settled;
        });
      } catch (caught) {
        setHistory((current) => {
          const settled = replaceMessage(current, threadId, replyId, {
            content: streamed,
            error: (caught as Error).message,
          });
          store.save(settled);
          return settled;
        });
      } finally {
        setStreaming(false);
        abort.current = null;
      }
    },
    [activeThread, commit, history, limits, liveCredential, model, store],
  );

  const historyCopy = HISTORY_COPY[settings.historyStorage.toLowerCase()] ?? HISTORY_COPY.browser_local;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start gap-3">
        <ModelPicker
          models={models}
          value={model?.id ?? ''}
          onChange={(id) => {
            setModelId(id);
            // A thread carries the model it is talking to, so switching changes
            // this conversation rather than only the next one.
            if (activeThread) {
              commit({
                ...history,
                threads: history.threads.map((thread) =>
                  thread.id === activeThread.id ? { ...thread, modelId: id } : thread,
                ),
              });
            }
          }}
          disabled={streaming}
        />
        {endpoint ? (
          <div className="min-w-64 flex-1">
            <VerificationBadge
              verification={verification}
              hostname={endpoint.hostname}
              evidenceDigestHex={endpoint.latestEvidence?.evidenceDigestHex ?? null}
              extensionUrl={EXTENSION_URL}
            />
          </div>
        ) : null}
      </div>

      <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
        <div className="lg:h-[32rem]">
          <ThreadList
            threads={history.threads}
            activeThreadId={activeThreadId}
            maxThreads={settings.maxThreads}
            onSelect={setActiveThreadId}
            onCreate={() => {
              const thread = newThread(model?.id ?? modelId);
              commit(addThread(history, thread, limits));
              setActiveThreadId(thread.id);
            }}
            onDelete={(threadId) => {
              const next = deleteThread(history, threadId);
              commit(next);
              if (threadId === activeThreadId) {
                setActiveThreadId(next.threads[0]?.id ?? null);
              }
            }}
          />
        </div>

        <div className="flex min-h-96 flex-col gap-3 rounded-xl border p-4 lg:h-[32rem]">
          <div className="min-h-0 flex-1 overflow-y-auto">
            {activeThread && activeThread.messages.length > 0 ? (
              <MessageList messages={activeThread.messages} streaming={streaming} />
            ) : (
              <EmptyState
                icon={<ShieldQuestionMark className="size-5" aria-hidden="true" />}
                title="Nothing sent yet"
                description="The endpoint's evidence is checked in this browser before the first message can leave it."
                className="h-full border-0"
              />
            )}
          </div>

          <Composer
            onSend={(content) => {
              void send(content);
            }}
            onStop={() => abort.current?.abort()}
            unlocked={verification.unlocked}
            streaming={streaming}
            maxChars={settings.maxMessageChars}
            lockedReason={
              verification.pageState === 'fail'
                ? 'This endpoint’s evidence did not check out, so nothing will be sent.'
                : 'Checking this endpoint’s evidence…'
            }
          />
        </div>
      </div>

      <p className="max-w-prose text-muted-foreground text-xs">
        <span className="text-foreground">{historyCopy.summary}</span> {historyCopy.detail}
      </p>
    </div>
  );
}
