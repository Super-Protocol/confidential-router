'use client';

import * as React from 'react';
import { cn } from '../../lib/utils';

export interface BarDatum {
  /** Bucket label — the x axis value, e.g. an ISO date or `14:00`. */
  label: string;
  value: number;
  /** Overrides the bar colour; defaults to the brand accent. */
  color?: string;
}

export interface BarChartProps extends Omit<React.ComponentProps<'div'>, 'children'> {
  data: BarDatum[];
  /**
   * Required. A bar chart drawn out of `<div>`s is invisible to a screen
   * reader, so the component refuses to exist without a text equivalent.
   */
  label: string;
  /** Bar area height in pixels. */
  height?: number;
  /** Formats a value for the per-bar tooltip and for the fallback table. */
  format?: (value: number) => string;
}

const EMPTY_BAR_HEIGHT = '2px';

/**
 * The compact bar strip from the prototype's stat cards: value bars in the
 * accent, zero buckets as a flat neutral tick so the axis stays legible.
 *
 * Scaled against the largest bucket rather than a fixed ceiling — these strips
 * show shape, not absolute magnitude, and the number above them carries the
 * magnitude.
 */
export function BarChart({ data, label, height = 56, format = String, className, ...props }: BarChartProps) {
  const max = data.reduce((acc, d) => Math.max(acc, d.value), 0);

  return (
    <div className={cn('flex flex-col gap-2', className)} {...props}>
      <div
        role="img"
        aria-label={label}
        className="flex items-end gap-[3px]"
        style={{ height: `${height}px` }}
        data-slot="bar-chart"
      >
        {data.map((d) => (
          <div
            key={d.label}
            title={`${d.label}: ${format(d.value)}`}
            className={cn('flex-1 rounded-[2px]', d.value > 0 ? 'bg-brand' : 'bg-muted-foreground/40')}
            style={{
              height: max > 0 && d.value > 0 ? `${Math.max((d.value / max) * 100, 3)}%` : EMPTY_BAR_HEIGHT,
              backgroundColor: d.value > 0 ? d.color : undefined,
            }}
          />
        ))}
      </div>
      {/*
        The same numbers as a table, hidden visually but read out in full by a
        screen reader. `sr-only` rather than `aria-hidden` on the bars alone,
        because the bars still carry the `img` role and its label.
      */}
      <table className="sr-only">
        <caption>{label}</caption>
        <thead>
          <tr>
            <th scope="col">Bucket</th>
            <th scope="col">Value</th>
          </tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.label}>
              <th scope="row">{d.label}</th>
              <td>{format(d.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
