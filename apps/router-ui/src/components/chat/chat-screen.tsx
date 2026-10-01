'use client';

import { useMutation, useQuery } from '@apollo/client/react';
import { EmptyState } from '@confidential-router/ui/components/empty-state';
import { ErrorState } from '@confidential-router/ui/components/error-state';
import { Skeleton } from '@confidential-router/ui/components/skeleton';
import { MessagesSquare, ShieldQuestionMark } from 'lucide-react';
import * as React from 'react';
import type { ChatScreenQuery } from '../../generated/graphql';
import { useSession } from '../session/session-provider';
import { type PendingMessage, promptMessages } from './chat-history';
import { type StreamOutcome, streamChatCompletion } from './chat-stream';
import { Composer } from './composer';
import { MessageList } from './message-list';
import { ModelPicker } from './model-picker';
import {
  APPEND_CHAT_MESSAGE,
  CHAT_CREDENTIAL,
  CHAT_SCREEN_QUERY,
  CHAT_THREAD,
  CHAT_THREADS,
  CREATE_CHAT_THREAD,
  DELETE_CHAT_THREAD,
  SET_CHAT_THREAD_MODEL,
} from './operations';
import { ThreadList } from './thread-list';
import { HISTORY_COPY, lockedReasonOf } from './verification/tiers';
import { useVerification } from './verification/use-verification';
import { VerificationBadge } from './verification-badge';

type CatalogueModel = ChatScreenQuery['models'][number];

/** Where the extension is published. Absent until it ships, which hides the link. */
const EXTENSION_URL = undefined;

/**
 * The gateway's OpenAI error codes that mean "this key is no longer a key"
 * (`app/api/v1/openai-error.ts`). They are the only refusals worth re-minting
 * for: everything else — no credit, over the rate limit, a model outside scope —
 * would fail again with a fresh key, and retrying would just double the work.
 */
const STALE_CREDENTIAL_CODES = new Set(['api_key_revoked', 'api_key_expired', 'invalid_api_key']);

/**
 * Swallows a fire-and-forget refetch's failure.
 *
 * These calls are refreshes, not results: the turn is already stored, and the
 * next render reads it whether or not this particular request lands. Without the
 * catch a refetch torn down mid-flight — the user navigating away as an answer
 * settles — surfaces as an unhandled rejection from Apollo's internals, which is
 * noise about nothing.
 */
function refresh(pending: Promise<unknown>): void {
  void pending.catch(() => undefined);
}

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
 *  - **The transcript lives where the API says it lives.** That is now
 *    `chat_threads` / `chat_messages` on the deployment's own state, inside the
 *    attested boundary and encrypted at rest — and explicitly *not* durable: the
 *    state disk is ephemeral by design, so a conversation can be lost during
 *    infrastructure maintenance. The screen derives its storage note from
 *    `chatSettings.historyStorage` rather than hard-coding one, so it cannot
 *    describe storage the deployment does not have, and the note names the
 *    maintenance caveat in the same breath as the boundary.
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

  // Keyed on the workspace: transcripts are stored per workspace, and switching
  // should start the screen over rather than carry one across tenants.
  return <ChatSession key={activeWorkspace.id} workspaceId={activeWorkspace.id} models={models} settings={settings} />;
}

interface ChatSessionProps {
  workspaceId: string;
  models: CatalogueModel[];
  settings: NonNullable<ChatScreenQuery['chatSettings']>;
}

function ChatSession({ workspaceId, models, settings }: ChatSessionProps) {
  const [activeThreadId, setActiveThreadId] = React.useState<string | null>(null);
  const [modelId, setModelId] = React.useState<string>(models[0]?.id ?? '');
  /** The assistant turn still arriving. Not a message until the stream settles. */
  const [pending, setPending] = React.useState<PendingMessage | null>(null);
  const [streaming, setStreaming] = React.useState(false);
  const abort = React.useRef<AbortController | null>(null);

  const threadsQuery = useQuery(CHAT_THREADS, { variables: { workspaceId }, fetchPolicy: 'cache-and-network' });
  const threads = threadsQuery.data?.chatThreads ?? [];

  const threadQuery = useQuery(CHAT_THREAD, {
    variables: { workspaceId, threadId: activeThreadId ?? '' },
    skip: activeThreadId === null,
    fetchPolicy: 'cache-and-network',
  });
  const activeThread = activeThreadId === null ? null : (threadQuery.data?.chatThread ?? null);

  // Opens the most recent conversation once the list arrives, and only while the
  // user has not chosen one — so a deliberate "New conversation" is not undone by
  // a refetch landing a moment later.
  React.useEffect(() => {
    if (activeThreadId === null && threads.length > 0) {
      setActiveThreadId(threads[0]?.id ?? null);
    }
  }, [activeThreadId, threads]);

  const [createThread] = useMutation(CREATE_CHAT_THREAD);
  const [setThreadModel] = useMutation(SET_CHAT_THREAD_MODEL);
  const [appendMessage] = useMutation(APPEND_CHAT_MESSAGE);
  const [removeThread] = useMutation(DELETE_CHAT_THREAD);

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
      // The gate, checked here and not only in the Composer's `disabled`. The
      // whole promise of tier 1 is that nothing reaches the model before the
      // endpoint's evidence checks out, and a disabled control is a presentation
      // detail — the function that actually sends has to hold the invariant.
      if (!model || !verification.unlocked) return;

      setStreaming(true);
      setPending({ content: '' });
      const controller = new AbortController();
      abort.current = controller;
      let streamed = '';

      try {
        // A conversation to hang the turn on. The server names it after this
        // first message, so nothing here invents a title.
        let threadId = activeThreadId;
        if (threadId === null) {
          const created = await createThread({ variables: { input: { workspaceId, modelId: model.id } } });
          threadId = created.data?.createChatThread.id ?? null;
          if (threadId === null) {
            throw new Error('The conversation could not be started.');
          }
          setActiveThreadId(threadId);
        }

        // The question is stored before it is sent. A tab that dies mid-answer
        // then leaves a question in the transcript rather than losing the turn —
        // and a message over the server's ceiling is refused here, before any
        // inference is paid for.
        await appendMessage({ variables: { input: { workspaceId, threadId, role: 'USER', content } } });

        // The turns are assembled from the transcript already on screen plus the
        // message just sent — not from a re-read. One fewer round trip per
        // message, and it avoids depending on a query that is still skipped on the
        // very first message of a new conversation.
        const turns = [...promptMessages(activeThread?.messages ?? []), { role: 'user' as const, content }];

        const attempt = async (): Promise<StreamOutcome> => {
          const { secret, baseUrl } = await liveCredential();
          return streamChatCompletion({
            baseUrl,
            apiKey: secret,
            model: model.id,
            messages: turns,
            signal: controller.signal,
            onDelta: (delta) => {
              streamed += delta;
              setPending({ content: streamed });
            },
          });
        };

        let outcome = await attempt();

        /*
         * One retry when the gateway says the credential is gone.
         *
         * A chat key can stop authenticating while a tab still holds it — it
         * expired, an operator revoked it from the Keys screen, or this user
         * opened the chat in a second tab and rotated their own key. The cached
         * secret is then worth nothing and the user is looking at a failed
         * message, so the screen drops it and mints once rather than making them
         * reload to recover.
         *
         * Guarded on `streamed` being empty: these refusals arrive from the
         * guard, before any body, so in practice nothing has been emitted — and
         * if something somehow had been, replaying the request would duplicate
         * it in the transcript, which is worse than surfacing the error.
         */
        if (outcome.status === 'error' && STALE_CREDENTIAL_CODES.has(outcome.code ?? '') && streamed.length === 0) {
          credential.current = null;
          outcome = await attempt();
        }

        // Show the refusal at once rather than waiting for the stored copy to be
        // read back: the user is looking at a failed message now, and a round trip
        // is a second or two of an empty bubble with no explanation.
        if (outcome.status === 'error') {
          setPending({ content: streamed, error: outcome.message });
        }

        // The answer becomes a row, error and all: a stream that died halfway is
        // more honest kept, with what arrived and why it stopped.
        await appendMessage({
          variables: {
            input: {
              workspaceId,
              threadId,
              role: 'ASSISTANT',
              content: streamed,
              // Explicitly null rather than an absent key: the field is nullable,
              // and "no error" is a value worth sending rather than an omission a
              // reader has to infer.
              error: outcome.status === 'error' ? outcome.message : null,
            },
          },
        });
      } catch (caught) {
        // The turn could not be *recorded* — the mutation was refused, or the
        // credential could not be minted. There is no server copy to fall back
        // to, so this one is marked `unstored` and kept on screen.
        setPending({ content: streamed, error: (caught as Error).message, unstored: true });
        return;
      } finally {
        setStreaming(false);
        abort.current = null;
        // The list re-sorts, because this conversation just moved to the top.
        refresh(threadsQuery.refetch());
        refresh(threadQuery.refetch());
      }
    },
    [
      activeThread?.messages,
      activeThreadId,
      appendMessage,
      createThread,
      liveCredential,
      model,
      threadQuery,
      threadsQuery,
      verification.unlocked,
      workspaceId,
    ],
  );

  /*
   * A stream must not outlive the screen.
   *
   * Without this, navigating away mid-answer leaves `reader.read()` pending on a
   * body nobody is listening to, and the abort surfaces as an unhandled
   * `AbortError` rather than as the `{ status: 'aborted' }` the caller handles.
   */
  React.useEffect(() => {
    return () => abort.current?.abort();
  }, []);

  /*
   * Drops the local copy of the answer once the stored one is on screen.
   *
   * Declarative rather than sequenced after the refetch, because either query can
   * be the one that lands the assistant turn — the explicit refetch, or the
   * ordinary query un-skipping after a new conversation's first message. Clearing
   * on a timer or immediately after the mutation would take the reply off the
   * screen and put it back, which reads as a flicker.
   *
   * An `unstored` turn is left alone: nothing was written for it, so there is no
   * server copy coming, and it is the only record the user has of what went wrong.
   * A *stored* error turn is cleared like any other — the transcript now carries
   * the same message, and keeping both would show it twice.
   */
  React.useEffect(() => {
    if (streaming || pending === null || pending.unstored === true) return;
    if (activeThread?.messages.at(-1)?.role === 'ASSISTANT') {
      setPending(null);
    }
  }, [activeThread?.messages, pending, streaming]);

  const historyCopy = HISTORY_COPY[settings.historyStorage.toLowerCase()] ?? HISTORY_COPY.attested_server;

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
            if (activeThreadId !== null) {
              refresh(setThreadModel({ variables: { input: { workspaceId, modelId: id }, threadId: activeThreadId } }));
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
            threads={threads}
            activeThreadId={activeThreadId}
            maxThreads={settings.maxThreads}
            onSelect={setActiveThreadId}
            onCreate={() => {
              // No thread is created until the first message: an empty one would
              // be a row nobody asked for, and the server names a thread after
              // the message that starts it.
              setActiveThreadId(null);
              setPending(null);
            }}
            onDelete={(threadId) => {
              refresh(
                (async () => {
                  await removeThread({ variables: { workspaceId, threadId } });
                  if (threadId === activeThreadId) {
                    setActiveThreadId(null);
                  }
                  await threadsQuery.refetch();
                })(),
              );
            }}
          />
        </div>

        <div className="flex min-h-96 flex-col gap-3 rounded-xl border p-4 lg:h-[32rem]">
          <div className="min-h-0 flex-1 overflow-y-auto">
            {activeThread && activeThread.messages.length > 0 ? (
              <MessageList messages={activeThread.messages} pending={pending} />
            ) : pending ? (
              <MessageList messages={[]} pending={pending} />
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
            lockedReason={lockedReasonOf(verification.gate)}
          />
        </div>
      </div>

      <p className="max-w-prose text-muted-foreground text-xs">
        <span className="text-foreground">{historyCopy.summary}</span> {historyCopy.detail}
      </p>
    </div>
  );
}
