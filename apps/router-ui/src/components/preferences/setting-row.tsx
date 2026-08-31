import type * as React from 'react';

export interface SettingRowProps {
  /** The control's own id, so the row's title labels it. */
  htmlFor?: string;
  title: string;
  description: React.ReactNode;
  /** The switch, select or button on the right of the row. */
  control: React.ReactNode;
}

/**
 * One settings row: what it is on the left, the control on the right.
 *
 * The title is a `<label>` when it labels a control and a `<span>` when the row
 * is read-only, so a screen reader is never told that a piece of text is the
 * label of something that cannot be changed.
 */
export function SettingRow({ htmlFor, title, description, control }: SettingRowProps) {
  return (
    <div className="flex items-start justify-between gap-6 border-b px-6 py-4 last:border-b-0">
      <div className="space-y-1">
        {htmlFor ? (
          <label className="font-medium text-sm" htmlFor={htmlFor}>
            {title}
          </label>
        ) : (
          <p className="font-medium text-sm">{title}</p>
        )}
        <p className="max-w-prose text-muted-foreground text-sm">{description}</p>
      </div>
      <div className="shrink-0 pt-0.5">{control}</div>
    </div>
  );
}
