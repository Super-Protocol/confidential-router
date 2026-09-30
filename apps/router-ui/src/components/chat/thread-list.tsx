'use client';

import { Button } from '@confidential-router/ui/components/button';
import { cn } from '@confidential-router/ui/lib/utils';
import { MessageSquarePlus, Trash2 } from 'lucide-react';

/** Only what a sidebar row renders; the server sends more and this ignores it. */
export interface ThreadSummary {
  id: string;
  title: string;
}

export interface ThreadListProps {
  threads: readonly ThreadSummary[];
  activeThreadId: string | null;
  onSelect: (threadId: string) => void;
  onDelete: (threadId: string) => void;
  onCreate: () => void;
  /** From `chatSettings`, so the list can say how much room is left. */
  maxThreads: number;
}

/**
 * The conversations stored for this member.
 *
 * Delete is a hard delete and says so: no archive, no tombstone. The thread row
 * goes and `chat_messages` cascades from it, so there is nothing left to ask us
 * for afterwards.
 */
export function ThreadList({ threads, activeThreadId, onSelect, onDelete, onCreate, maxThreads }: ThreadListProps) {
  return (
    <div className="flex h-full flex-col gap-2">
      <Button variant="outline" size="sm" onClick={onCreate} className="justify-start">
        <MessageSquarePlus aria-hidden="true" />
        New conversation
      </Button>

      <ul aria-label="Conversations" className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
        {threads.map((thread) => {
          const active = thread.id === activeThreadId;
          return (
            <li key={thread.id} className="group/thread flex items-center gap-1">
              <button
                type="button"
                onClick={() => onSelect(thread.id)}
                aria-current={active ? 'true' : undefined}
                className={cn(
                  'min-w-0 flex-1 truncate rounded-md px-2.5 py-1.5 text-left text-sm outline-none transition-colors',
                  'focus-visible:ring-[3px] focus-visible:ring-ring/50',
                  active ? 'bg-accent font-medium text-accent-foreground' : 'text-foreground/70 hover:bg-accent/60',
                )}
              >
                {thread.title}
              </button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Delete “${thread.title}”`}
                onClick={() => onDelete(thread.id)}
                className="opacity-0 transition-opacity focus-visible:opacity-100 group-hover/thread:opacity-100"
              >
                <Trash2 aria-hidden="true" />
              </Button>
            </li>
          );
        })}
      </ul>

      <p className="text-muted-foreground text-xs">
        {threads.length} of {maxThreads} conversations kept. The oldest is dropped past that.
      </p>
    </div>
  );
}
