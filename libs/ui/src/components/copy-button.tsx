'use client';

import { Check, Copy, X } from 'lucide-react';
import * as React from 'react';
import { cn } from '../lib/utils';
import { Button } from './button';

/** How long the button stays in its "copied" / "failed" state before resetting. */
const RESET_DELAY_MS = 2000;

type CopyState = 'idle' | 'copied' | 'failed';

export interface CopyButtonProps extends Omit<React.ComponentProps<typeof Button>, 'value' | 'onClick' | 'children'> {
  /** The text put on the clipboard. */
  value: string;
  /**
   * Accessible name in the idle state. Several copy buttons usually share one
   * screen, so name what is being copied: "Copy the API key", not "Copy".
   */
  label?: string;
  copiedLabel?: string;
  failedLabel?: string;
  /** Renders the label next to the icon instead of only for assistive tech. */
  showLabel?: boolean;
}

/**
 * One clipboard button for the whole console.
 *
 * The label — not a tooltip or a toast — carries the result, so the outcome is
 * available to a screen reader and to a test by the button's accessible name.
 */
export function CopyButton({
  value,
  label = 'Copy',
  copiedLabel = 'Copied',
  failedLabel = 'Copy failed',
  showLabel = false,
  variant = 'ghost',
  size = 'sm',
  className,
  ...props
}: CopyButtonProps) {
  const [state, setState] = React.useState<CopyState>('idle');
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      // A blocked clipboard is the browser's decision, not an application
      // error: say so on the button and leave the text selectable.
      setState('failed');
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), RESET_DELAY_MS);
  };

  const Icon = state === 'copied' ? Check : state === 'failed' ? X : Copy;
  const text = state === 'copied' ? copiedLabel : state === 'failed' ? failedLabel : label;

  return (
    <Button
      type="button"
      data-slot="copy-button"
      data-state={state}
      variant={variant}
      size={size}
      className={cn(showLabel ? '' : 'px-2', className)}
      onClick={() => void copy()}
      {...props}
    >
      <Icon className={cn('size-3.5', state === 'copied' && 'text-success')} aria-hidden="true" />
      <span className={cn(showLabel ? '' : 'sr-only')}>{text}</span>
    </Button>
  );
}
