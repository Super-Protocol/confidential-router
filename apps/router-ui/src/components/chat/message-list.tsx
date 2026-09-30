'use client';

import { cn } from '@confidential-router/ui/lib/utils';
import * as React from 'react';
import type { ChatMessage } from './chat-history';

export interface MessageListProps {
  messages: ChatMessage[];
  /** True while the last assistant turn is still arriving. */
  streaming: boolean;
}

/**
 * The transcript.
 *
 * Rendered as plain text, never as Markdown or HTML: the content is model output
 * being shown back inside the console, and a renderer here would be a parser
 * trusting a string the router deliberately does not inspect. `whitespace-pre-wrap`
 * keeps code blocks and lists legible without one.
 */
export function MessageList({ messages, streaming }: MessageListProps) {
  const end = React.useRef<HTMLDivElement>(null);

  // Follows the stream. `messages` changes identity on every delta, which is
  // exactly the cadence a transcript should scroll at — the effect body never
  // reads it, it only has to run when it changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `messages` is the trigger, not an input.
  React.useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  return (
    <div className="flex flex-col gap-4">
      {messages.map((message, index) => (
        <div
          key={message.id}
          className={cn('flex flex-col gap-1', message.role === 'user' ? 'items-end' : 'items-start')}
        >
          <span className="px-1 text-muted-foreground text-xs">{message.role === 'user' ? 'You' : 'Model'}</span>
          <div
            className={cn(
              'max-w-[min(42rem,90%)] whitespace-pre-wrap rounded-xl px-3.5 py-2.5 text-sm',
              message.role === 'user' ? 'bg-accent text-accent-foreground' : 'border bg-card',
              message.error ? 'border-destructive/40' : null,
            )}
          >
            {message.content.length > 0 ? (
              message.content
            ) : streaming && index === messages.length - 1 ? (
              <span className="text-muted-foreground">…</span>
            ) : null}
            {message.error ? (
              <p role="alert" className="mt-2 text-destructive text-xs">
                {message.error}
              </p>
            ) : null}
          </div>
        </div>
      ))}
      <div ref={end} />
    </div>
  );
}
