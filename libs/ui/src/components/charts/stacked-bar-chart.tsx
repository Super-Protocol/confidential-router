'use client';

import * as React from 'react';
import { cn } from '../../lib/utils';

export interface StackedSeries {
  /** Key into each datum's `values`. Also the React key, so it must be unique. */
  key: string;
  label: string;
  /**
   * CSS colour for the series. Defaults walk the `--chart-*` ramp, which is
   * tuned for both themes; pass a colour only to match something outside it.
   */
  color?: string;
}

export interface StackedBarDatum {
  /** Bucket label — the x axis value, e.g. `31 Jul` or a model name. */
  label: string;
  /**
   * Stable identity, when the label is not one. A rolling 24-hour window opens
   * and closes on the same hour, so `14:00` names two different buckets and
   * keying React on the label would collapse them into one column.
   */
  id?: string;
  /** Missing or negative series values count as zero. */
  values: Record<string, number>;
}

export interface StackedBarChartProps extends Omit<React.ComponentProps<'div'>, 'children'> {
  data: StackedBarDatum[];
  series: StackedSeries[];
  /**
   * Required. A chart drawn out of `<div>`s is invisible to a screen reader, so
   * the component refuses to exist without a text equivalent — same contract as
   * `BarChart`.
   */
  label: string;
  /** Bar area height in pixels. */
  height?: number;
  /** Formats a value for the per-segment tooltip and for the fallback table. */
  format?: (value: number) => string;
  /** Renders the series legend under the bars. */
  legend?: boolean;
  /**
   * X-axis ticks. `all` labels every column — right for a handful of named
   * categories. `sparse` keeps at most `maxTicks` of them and blanks the rest,
   * which is what thirty days of buckets needs.
   */
  axis?: 'none' | 'all' | 'sparse';
  maxTicks?: number;
}

/** Five steps, because `--chart-*` defines five and a sixth series would repeat. */
const SERIES_COLORS = [
  'var(--color-chart-1)',
  'var(--color-chart-2)',
  'var(--color-chart-3)',
  'var(--color-chart-4)',
  'var(--color-chart-5)',
] as const;

const EMPTY_BAR_HEIGHT = '2px';

export function seriesColor(series: StackedSeries, index: number): string {
  return series.color ?? SERIES_COLORS[index % SERIES_COLORS.length];
}

function totalOf(datum: StackedBarDatum, series: StackedSeries[]): number {
  return series.reduce((sum, s) => sum + Math.max(datum.values[s.key] ?? 0, 0), 0);
}

/**
 * Which columns get a visible tick. Always the first and the last, then evenly
 * spaced ones between — the shape the prototype's "31 Jul … 30 Aug" axis has.
 *
 * Blanking the rest rather than dropping them keeps one span per column, so the
 * ticks stay under the bars they name however the container is sized.
 */
export function tickIndices(count: number, maxTicks: number): Set<number> {
  if (count === 0) return new Set();
  if (count <= maxTicks || maxTicks < 2) return new Set(Array.from({ length: count }, (_, index) => index));

  const step = (count - 1) / (maxTicks - 1);
  return new Set(Array.from({ length: maxTicks }, (_, index) => Math.round(index * step)));
}

/**
 * Composition over time: one column per bucket, split into the series that make
 * it up.
 *
 * Columns are scaled against the tallest *total*, not against each series'
 * own maximum — the whole point of stacking is that column heights compare, and
 * per-series scaling would silently break that. An all-zero column keeps the
 * flat neutral tick `BarChart` uses, so a quiet bucket stays visible as a bucket
 * rather than vanishing from the axis.
 */
export function StackedBarChart({
  data,
  series,
  label,
  height = 160,
  format = String,
  legend = true,
  axis = 'none',
  maxTicks = 6,
  className,
  ...props
}: StackedBarChartProps) {
  const max = data.reduce((acc, datum) => Math.max(acc, totalOf(datum, series)), 0);
  const ticks = axis === 'sparse' ? tickIndices(data.length, maxTicks) : null;

  return (
    <div className={cn('flex flex-col gap-2', className)} {...props}>
      <div
        role="img"
        aria-label={label}
        className="flex items-end gap-[3px]"
        style={{ height: `${height}px` }}
        data-slot="stacked-bar-chart"
      >
        {data.map((datum) => {
          const total = totalOf(datum, series);

          return (
            <div
              key={datum.id ?? datum.label}
              data-slot="stacked-bar"
              className="flex h-full min-w-0 flex-1 flex-col justify-end overflow-hidden rounded-[2px]"
            >
              {total > 0 ? (
                // `justify-end` stacks upward from the baseline, so the *last*
                // series in the array is the one sitting on the axis. Segments
                // are laid out in series order in every column, which is what
                // lets a reader compare the same band across buckets.
                series.map((s, index) => {
                  const value = Math.max(datum.values[s.key] ?? 0, 0);
                  if (value === 0) return null;

                  return (
                    <div
                      key={s.key}
                      title={`${datum.label} · ${s.label}: ${format(value)}`}
                      style={{
                        height: `${(value / max) * 100}%`,
                        backgroundColor: seriesColor(s, index),
                      }}
                    />
                  );
                })
              ) : (
                <div className="bg-muted-foreground/40" style={{ height: EMPTY_BAR_HEIGHT }} />
              )}
            </div>
          );
        })}
      </div>

      {axis === 'none' ? null : (
        <div aria-hidden="true" className="flex items-start gap-[3px] text-muted-foreground text-xs" data-slot="axis">
          {data.map((datum, index) => (
            <span key={datum.id ?? datum.label} className="min-w-0 flex-1 truncate text-center" title={datum.label}>
              {ticks === null || ticks.has(index) ? datum.label : ''}
            </span>
          ))}
        </div>
      )}

      {legend ? (
        <ul className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-muted-foreground text-xs">
          {series.map((s, index) => (
            <li key={s.key} className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="size-2 shrink-0 rounded-[2px]"
                style={{ backgroundColor: seriesColor(s, index) }}
              />
              {s.label}
            </li>
          ))}
        </ul>
      ) : null}

      {/*
        The same numbers as a table, hidden visually but read out in full by a
        screen reader — see `BarChart`. One column per series plus the total,
        because the total is the value the columns are scaled by.
      */}
      <table className="sr-only">
        <caption>{label}</caption>
        <thead>
          <tr>
            <th scope="col">Bucket</th>
            {series.map((s) => (
              <th key={s.key} scope="col">
                {s.label}
              </th>
            ))}
            <th scope="col">Total</th>
          </tr>
        </thead>
        <tbody>
          {data.map((datum) => (
            <tr key={datum.id ?? datum.label}>
              <th scope="row">{datum.label}</th>
              {series.map((s) => (
                <td key={s.key}>{format(Math.max(datum.values[s.key] ?? 0, 0))}</td>
              ))}
              <td>{format(totalOf(datum, series))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
