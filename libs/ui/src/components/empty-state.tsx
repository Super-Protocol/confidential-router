import type * as React from 'react';
import { cn } from '../lib/utils';

export interface EmptyStateProps extends React.ComponentProps<'div'> {
  /** Rendered inside a muted circle; pass a lucide icon element. */
  icon?: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  /** Primary call to action — usually a `Button`. */
  action?: React.ReactNode;
}

/**
 * The one shape every "nothing here yet" surface in the console uses, so an
 * empty table and an empty log both read the same way.
 */
export function EmptyState({ icon, title, description, action, className, ...props }: EmptyStateProps) {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-6 py-12 text-center',
        className,
      )}
      {...props}
    >
      {icon ? (
        <div className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
          {icon}
        </div>
      ) : null}
      <div className="space-y-1">
        <p className="font-medium text-sm">{title}</p>
        {description ? <div className="max-w-prose text-muted-foreground text-sm">{description}</div> : null}
      </div>
      {action}
    </div>
  );
}
