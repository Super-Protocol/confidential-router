import { cn } from '@confidential-router/ui/lib/utils';
import type * as React from 'react';

/**
 * The shield-and-check mark from the prototype. Purely decorative wherever it
 * sits next to the product name, hence `aria-hidden` by default.
 */
export function BrandMark({ className, ...props }: React.ComponentProps<'svg'>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.1}
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn('size-4', className)}
      {...props}
    >
      <path d="M12 3l7 3v6c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6l7-3z" />
      <path d="M9 12.2l2.2 2.2L15.4 10" strokeLinecap="round" />
    </svg>
  );
}
