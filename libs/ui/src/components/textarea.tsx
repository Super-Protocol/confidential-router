/**
 * Ported from Super-Protocol/swarm-cloud `libs/ui/src/components/textarea.tsx` (BSL-1.1)
 * with permission; see the repository NOTICE. Upstream: shadcn/ui (MIT).
 *
 * The one multi-line field in the console. It keeps `Input`'s focus and invalid
 * rings so a form that mixes the two does not change shape halfway down.
 */
import type * as React from 'react';

import { cn } from '../lib/utils';

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'placeholder:text-muted-foreground dark:bg-input/30 border-input field-sizing-content flex min-h-16 w-full rounded-md border bg-transparent px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
        'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]',
        'aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive',
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
