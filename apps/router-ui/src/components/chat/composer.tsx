'use client';

import { Button } from '@confidential-router/ui/components/button';
import { Textarea } from '@confidential-router/ui/components/textarea';
import { CircleStop, Loader2, SendHorizontal } from 'lucide-react';
import * as React from 'react';

export interface ComposerProps {
  onSend: (content: string) => void;
  onStop: () => void;
  /** False until the in-page evidence gate has passed. */
  unlocked: boolean;
  streaming: boolean;
  maxChars: number;
  /** Why the composer is locked, when it is. */
  lockedReason: string;
}

/**
 * The input, and the gate in front of it.
 *
 * The composer is disabled until tier 1 has passed, and the reason is rendered
 * where the send button is rather than in a toast: the point of an evidence gate
 * is that the user knows nothing left the browser, and that has to be visible at
 * the moment they would have pressed send.
 */
export function Composer({ onSend, onStop, unlocked, streaming, maxChars, lockedReason }: ComposerProps) {
  const [value, setValue] = React.useState('');
  const overLimit = value.length > maxChars;
  const canSend = unlocked && !streaming && value.trim().length > 0 && !overLimit;

  const send = (): void => {
    if (!canSend) return;
    onSend(value.trim());
    setValue('');
  };

  return (
    <div className="space-y-2">
      <Textarea
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          // Enter sends, Shift+Enter breaks the line — the convention every chat
          // client has trained people on.
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            send();
          }
        }}
        disabled={!unlocked}
        aria-invalid={overLimit || undefined}
        aria-label="Message"
        placeholder={unlocked ? 'Ask the model something…' : 'Locked until this endpoint’s evidence checks out'}
        className="max-h-56 min-h-20"
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className={overLimit ? 'text-destructive text-xs' : 'text-muted-foreground text-xs'}>
          {unlocked ? `${value.length} / ${maxChars} characters` : lockedReason}
        </p>
        {streaming ? (
          <Button variant="outline" size="sm" onClick={onStop}>
            <CircleStop aria-hidden="true" />
            Stop
          </Button>
        ) : (
          <Button size="sm" disabled={!canSend} onClick={send}>
            {unlocked ? <SendHorizontal aria-hidden="true" /> : <Loader2 className="animate-spin" aria-hidden="true" />}
            Send
          </Button>
        )}
      </div>
    </div>
  );
}
