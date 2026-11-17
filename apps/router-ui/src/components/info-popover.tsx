'use client';

import { Popover, PopoverContent, PopoverTrigger } from '@confidential-router/ui/components/popover';
import { cn } from '@confidential-router/ui/lib/utils';
import { Info } from 'lucide-react';
import type * as React from 'react';

export interface InfoPopoverProps {
  /**
   * The trigger's accessible name — what a reader will find behind it. An
   * unlabelled ⓘ is how honest copy disappears: the trigger has to say that
   * there is an answer behind it, to a screen reader as much as to a sighted
   * reader (SUP-189).
   */
  label: string;
  children: React.ReactNode;
  className?: string;
  align?: 'start' | 'center' | 'end';
}

/**
 * The console's one shape for "the rest of the sentence": a ⓘ beside a short
 * line, and the qualification behind it.
 *
 * The rule it enforces is about placement, not honesty. Every explainer the
 * console used to render inline still ships, in the same words; what changed
 * (SUP-262) is that a paragraph no longer sits between two controls or hangs
 * under a card as a footnote. The affirmative half stays in the layout, the
 * reader opens the rest — the same recipe `storage-note.tsx` established.
 */
export function InfoPopover({ label, children, className, align = 'start' }: InfoPopoverProps) {
  return (
    <Popover>
      <PopoverTrigger
        aria-label={label}
        className={cn(
          'inline-flex shrink-0 items-center rounded-full text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50',
          className,
        )}
      >
        <Info className="size-3.5" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent align={align} className="w-80 space-y-2 text-muted-foreground text-xs">
        {children}
      </PopoverContent>
    </Popover>
  );
}
