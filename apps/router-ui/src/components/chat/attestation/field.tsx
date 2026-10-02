'use client';

import { CopyButton } from '@confidential-router/ui/components/copy-button';
import type * as React from 'react';

export interface FieldProps {
  label: string;
  /**
   * The value, or null when the evidence does not carry one. A null renders as
   * "not published" rather than as a blank, because a reader cannot tell a value
   * nobody published from a value the panel forgot to show.
   */
  value: string | null;
  /** A sentence under the value: what it is, or why it is not a verdict. */
  note?: React.ReactNode;
  /** Set for hex digests and fingerprints; renders monospace and wraps anywhere. */
  mono?: boolean;
  /** Overrides what the clipboard receives — the full value behind an abbreviation. */
  copyValue?: string;
  /** A tone marker rendered before the value, e.g. a verdict badge. */
  adornment?: React.ReactNode;
}

/**
 * One labelled field of the measurements panel, with a copy button when there is
 * something to copy.
 *
 * Every value here is something a reader is expected to compare with another
 * tool's output — `gatekeeper inspect`, `docker inspect`, the extension's popup —
 * so copy-to-clipboard is on the row rather than on the panel: a reader who has
 * to select 64 hex characters by hand will mis-select them.
 */
export function Field({ label, value, note, mono = false, copyValue, adornment }: FieldProps) {
  return (
    <div className="grid gap-x-4 gap-y-0.5 border-b py-2.5 last:border-b-0 sm:grid-cols-[minmax(10rem,14rem)_1fr]">
      <dt className="text-muted-foreground text-sm">{label}</dt>
      <dd className="min-w-0">
        <div className="flex min-w-0 items-start gap-1.5">
          {adornment}
          {value === null ? (
            <span className="text-muted-foreground text-sm italic">not published</span>
          ) : (
            <>
              <span className={mono ? 'min-w-0 break-all font-mono text-xs' : 'min-w-0 break-words text-sm'}>
                {value}
              </span>
              <CopyButton value={copyValue ?? value} label={`Copy ${label}`} className="-mt-1 shrink-0" />
            </>
          )}
        </div>
        {note ? <p className="max-w-prose text-muted-foreground text-xs">{note}</p> : null}
      </dd>
    </div>
  );
}

/** A titled group of {@link Field} rows. */
export function FieldGroup({
  title,
  description,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-1">
      <h3 className="font-medium text-sm">{title}</h3>
      {description ? <p className="max-w-prose text-muted-foreground text-xs">{description}</p> : null}
      <dl className="rounded-lg border px-4">{children}</dl>
    </section>
  );
}
