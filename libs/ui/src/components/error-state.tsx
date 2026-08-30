'use client';

import { RotateCcw, TriangleAlert } from 'lucide-react';
import type * as React from 'react';
import { cn } from '../lib/utils';
import { Button } from './button';

export interface ErrorStateProps extends React.ComponentProps<'div'> {
  title?: string;
  description?: React.ReactNode;
  /** Wired to Next's `reset` in `error.tsx`, or to an Apollo `refetch`. */
  onRetry?: () => void;
  retryLabel?: string;
  /**
   * Shown verbatim under the description. Only ever a digest or an operation
   * name — never a raw server message, which can carry data the viewer should
   * not see.
   */
  detail?: string;
}

export function ErrorState({
  title = 'Something went wrong',
  description = 'The request failed. Retrying usually helps; if it does not, the API may be unreachable.',
  onRetry,
  retryLabel = 'Try again',
  detail,
  className,
  ...props
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      data-slot="error-state"
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-6 py-12 text-center',
        className,
      )}
      {...props}
    >
      <div className="flex size-10 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <TriangleAlert className="size-5" aria-hidden="true" />
      </div>
      <div className="space-y-1">
        <p className="font-medium text-sm">{title}</p>
        <div className="max-w-prose text-muted-foreground text-sm">{description}</div>
        {detail ? <p className="font-mono text-muted-foreground text-xs">{detail}</p> : null}
      </div>
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RotateCcw aria-hidden="true" />
          {retryLabel}
        </Button>
      ) : null}
    </div>
  );
}
