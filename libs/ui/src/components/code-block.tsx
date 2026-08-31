import type * as React from 'react';
import { cn } from '../lib/utils';
import { CopyButton } from './copy-button';

export interface CodeBlockProps extends Omit<React.ComponentProps<'div'>, 'title'> {
  /** The snippet, verbatim. Rendered as text — never as HTML. */
  code: string;
  /** Shown above the snippet: a file name, a shell, a step. */
  title?: React.ReactNode;
  /**
   * Accessible name of the copy button. Default it only on a screen with one
   * block; anywhere else, name the snippet.
   */
  copyLabel?: string;
  /** Set for a snippet nobody would copy, e.g. sample output. */
  copyable?: boolean;
}

/**
 * A copyable snippet. Deliberately unhighlighted: the console shows shell
 * commands and short SDK calls, and a highlighter would add a parser (and its
 * `dangerouslySetInnerHTML`) for a handful of lines.
 */
export function CodeBlock({
  code,
  title,
  copyLabel = 'Copy the snippet',
  copyable = true,
  className,
  ...props
}: CodeBlockProps) {
  return (
    <div data-slot="code-block" className={cn('relative rounded-md border bg-muted/40', className)} {...props}>
      {title ? (
        <div className="flex items-center justify-between gap-2 border-b px-3 py-1.5 text-muted-foreground text-xs">
          {title}
        </div>
      ) : null}
      {copyable ? (
        <CopyButton value={code} label={copyLabel} className={cn('absolute right-1.5', title ? 'top-9' : 'top-1.5')} />
      ) : null}
      {/*
        Long lines wrap instead of scrolling sideways. A scrollable box has to be
        keyboard-reachable to satisfy WCAG 2.1.1 (axe:
        scrollable-region-focusable), and a `<pre>` in the tab order to hold a
        command nobody can interact with is a worse answer than one that fits:
        newlines and indentation are still preserved, and the copy button hands
        over the text verbatim whatever the wrapping did on screen.
      */}
      <pre
        className={cn(
          'overflow-x-auto whitespace-pre-wrap break-words p-3 text-xs leading-relaxed',
          copyable && 'pr-12',
        )}
      >
        <code className="font-mono">{code}</code>
      </pre>
    </div>
  );
}
