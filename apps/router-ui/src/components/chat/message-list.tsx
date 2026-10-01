'use client';

import { cn } from '@confidential-router/ui/lib/utils';
import * as React from 'react';
import type { PendingMessage, StoredMessage } from './chat-history';

export interface MessageListProps {
  /** The stored transcript, oldest first. */
  messages: readonly StoredMessage[];
  /** The assistant turn still arriving, which is not stored yet. */
  pending: PendingMessage | null;
}

/**
 * The transcript.
 *
 * Rendered as plain text, never as Markdown or HTML: the content is model output
 * being shown back inside the console, and a renderer here would be a parser
 * trusting a string the router deliberately does not inspect. `whitespace-pre-wrap`
 * keeps code blocks and lists legible without one.
 *
 * The streaming turn is drawn from `pending` rather than from `messages`, because
 * it is not a message yet — it becomes a row when the stream settles. Keeping the
 * two apart is what stops a half-arrived answer being indistinguishable from
 * history on a reload.
 */
export function MessageList({ messages, pending }: MessageListProps) {
  const end = React.useRef<HTMLDivElement>(null);

  // Follows the stream. The pending content changes on every delta, which is
  // exactly the cadence a transcript should scroll at — the effect body never
  // reads either value, it only has to run when they change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: both are triggers, not inputs.
  React.useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [messages, pending?.content]);

  return (
    <div className="flex flex-col gap-4">
      {messages.map((message) => (
        <Bubble key={message.id} mine={message.role === 'USER'} content={message.content} error={message.error} />
      ))}
      {pending ? <Bubble mine={false} content={pending.content} error={pending.error ?? null} streaming /> : null}
      <div ref={end} />
    </div>
  );
}

function Bubble({
  mine,
  content,
  error,
  streaming = false,
}: {
  mine: boolean;
  content: string;
  error: string | null;
  streaming?: boolean;
}) {
  return (
    <div className={cn('flex flex-col gap-1', mine ? 'items-end' : 'items-start')}>
      <span className="px-1 text-muted-foreground text-xs">{mine ? 'You' : 'Model'}</span>
      <div
        className={cn(
          'max-w-[min(42rem,90%)] whitespace-pre-wrap rounded-xl px-3.5 py-2.5 text-sm',
          mine ? 'bg-accent text-accent-foreground' : 'border bg-card',
          error ? 'border-destructive/40' : null,
        )}
      >
        {content.length > 0 ? content : streaming ? <span className="text-muted-foreground">…</span> : null}
        {error ? (
          <p role="alert" className="mt-2 text-destructive text-xs">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
