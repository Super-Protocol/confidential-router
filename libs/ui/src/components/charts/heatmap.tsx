'use client';

import * as React from 'react';
import { cn } from '../../lib/utils';

export interface HeatmapCell {
  /** ISO date (`YYYY-MM-DD`) — also the React key, so it must be unique. */
  date: string;
  value: number;
}

export interface HeatmapProps extends Omit<React.ComponentProps<'div'>, 'children'> {
  cells: HeatmapCell[];
  /** Required text equivalent — see `BarChart`. */
  label: string;
  /**
   * Upper bound of the colour scale. Defaults to the largest value present;
   * pass it explicitly when several heatmaps must share one scale.
   */
  max?: number;
  /** Rows per column. 7 (a calendar week) unless you have a reason. */
  rows?: number;
  format?: (cell: HeatmapCell) => string;
}

/** Five steps, because more than five are not distinguishable at 10px. */
const LEVEL_CLASSES = ['bg-muted', 'bg-brand/25', 'bg-brand/50', 'bg-brand/75', 'bg-brand'] as const;

function levelOf(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0;
  // `ceil` so any non-zero day is visibly warmer than an empty one.
  return Math.min(LEVEL_CLASSES.length - 1, Math.ceil((value / max) * (LEVEL_CLASSES.length - 1)));
}

/**
 * The contribution-graph heatmap from the prototype's Profile screen: days flow
 * down each column, columns are weeks. Column count follows from the data, so
 * the same component draws 30 days or 365.
 */
export function Heatmap({ cells, label, max, rows = 7, format, className, ...props }: HeatmapProps) {
  const ceiling = max ?? cells.reduce((acc, c) => Math.max(acc, c.value), 0);
  const columns = Math.max(1, Math.ceil(cells.length / rows));
  const describe = format ?? ((cell: HeatmapCell) => `${cell.date}: ${cell.value}`);

  return (
    <div className={cn('flex flex-col gap-2', className)} {...props}>
      <div
        role="img"
        aria-label={label}
        data-slot="heatmap"
        className="grid grid-flow-col gap-[3px]"
        style={{
          gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
        }}
      >
        {cells.map((cell) => (
          <div
            key={cell.date}
            title={describe(cell)}
            className={cn('aspect-square rounded-[2px]', LEVEL_CLASSES[levelOf(cell.value, ceiling)])}
          />
        ))}
      </div>
      <table className="sr-only">
        <caption>{label}</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">Value</th>
          </tr>
        </thead>
        <tbody>
          {cells.map((cell) => (
            <tr key={cell.date}>
              <th scope="row">{cell.date}</th>
              <td>{cell.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
