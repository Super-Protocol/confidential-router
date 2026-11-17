'use client';

import * as React from 'react';
import { cn } from '../../lib/utils';

export interface SparklineProps extends Omit<React.ComponentProps<'svg'>, 'children' | 'values'> {
  /**
   * One value per bucket, in order. `null` is a bucket the metric has no value
   * for — see the component note on why it is a gap and not a zero.
   */
  values: (number | null)[];
  /** Required text equivalent — see `BarChart`. */
  label: string;
  width?: number;
  height?: number;
  strokeWidth?: number;
}

/** A run of consecutive buckets that had a value, at their own x positions. */
interface Segment {
  points: string;
  /** Set when the run is a single bucket: a polyline of one point draws nothing. */
  dot: { x: number; y: number } | null;
}

/**
 * The 52×22 trend line from the prototype's model cards.
 *
 * A flat series (every value equal) is drawn as a mid-height straight line
 * rather than collapsing onto the baseline, which is what a naive
 * `(v - min) / (max - min)` does when `max === min`.
 *
 * A `null` bucket breaks the line and keeps its place on the x axis. Neither
 * alternative is honest: plotting it at zero invents a reading the metric never
 * took, and dropping it re-times every bucket after it — a 24-hour window with
 * two readings would draw a two-point line across the full width, which is what
 * a line over the whole day looks like (SUP-421).
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
  const segments = React.useMemo<Segment[]>(() => {
    const present = values.filter((value): value is number => value !== null);
    if (present.length === 0) return [];

    const min = Math.min(...present);
    const span = Math.max(...present) - min;
    const inset = strokeWidth;
    const usable = height - inset * 2;
    // Spaced over every bucket, present or not, so a gap costs its own width.
    const step = values.length > 1 ? width / (values.length - 1) : 0;

    const runs: { x: number; y: number }[][] = [];
    let run: { x: number; y: number }[] = [];
    values.forEach((value, index) => {
      if (value === null) {
        if (run.length > 0) runs.push(run);
        run = [];
        return;
      }
      const ratio = span === 0 ? 0.5 : (value - min) / span;
      run.push({ x: index * step, y: inset + (1 - ratio) * usable });
    });
    if (run.length > 0) runs.push(run);

    return runs.map((points) => ({
      points: points.map(({ x, y }) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' '),
      dot: points.length === 1 ? points[0] : null,
    }));
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
      {segments.map((segment) =>
        segment.dot ? (
          <circle
            key={segment.points}
            cx={segment.dot.x}
            cy={segment.dot.y}
            r={strokeWidth}
            fill="currentColor"
            stroke="none"
          />
        ) : (
          <polyline
            key={segment.points}
            points={segment.points}
            stroke="currentColor"
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ),
      )}
    </svg>
  );
}
