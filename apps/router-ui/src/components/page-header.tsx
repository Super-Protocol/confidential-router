import type * as React from 'react';

export interface PageHeaderProps {
  title: string;
  description?: React.ReactNode;
  /** Right-aligned actions for the screen. */
  actions?: React.ReactNode;
}

/** One heading shape for all nine screens, so `h1` order is never in doubt. */
export function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div className="space-y-1">
        <h1 className="font-semibold text-xl tracking-tight">{title}</h1>
        {description ? <p className="max-w-2xl text-muted-foreground text-sm">{description}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}
