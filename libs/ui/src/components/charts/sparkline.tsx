'use client';

import * as React from 'react';
import { cn } from '../../lib/utils';

export interface SparklineProps extends Omit<React.ComponentProps<'svg'>, 'children' | 'values'> {
  values: number[];
  /** Required text equivalent — see `BarChart`. */
  label: string;
  width?: number;
  height?: number;
  strokeWidth?: number;
}

/**
 * The 52×22 trend line from the prototype's model cards.
 *
 * A flat series (every value equal) is drawn as a mid-height straight line
 * rather than collapsing onto the baseline, which is what a naive
 * `(v - min) / (max - min)` does when `max === min`.
 */
export function Sparkline({
  values,
  label,
  width = 52,
  height = 22,
  strokeWidth = 1.4,
  className,
  ...props
}: SparklineProps) {
  const points = React.useMemo(() => {
    if (values.length === 0) return '';
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min;
    const inset = strokeWidth;
    const usable = height - inset * 2;
    const step = values.length > 1 ? width / (values.length - 1) : 0;

    return values
      .map((v, i) => {
        const ratio = span === 0 ? 0.5 : (v - min) / span;
        const y = inset + (1 - ratio) * usable;
        return `${(i * step).toFixed(2)},${y.toFixed(2)}`;
      })
      .join(' ');
  }, [values, width, height, strokeWidth]);

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      fill="none"
      className={cn('text-muted-foreground', className)}
      data-slot="sparkline"
      {...props}
    >
      <title>{label}</title>
      {points ? (
        <polyline
          points={points}
          stroke="currentColor"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : null}
    </svg>
  );
}
