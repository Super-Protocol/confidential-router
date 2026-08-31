import { BarChart, type BarDatum } from '@confidential-router/ui/components/charts/bar-chart';
import { cn } from '@confidential-router/ui/lib/utils';
import type * as React from 'react';

export interface StatTileProps {
  /** What the number is. Also the tile's accessible name. */
  label: string;
  /** The number, already formatted. */
  value: string;
  /** A short strip under the value — one bar per bucket of the period. */
  series?: BarDatum[];
  /** Formats a bar's value for its tooltip and for the screen-reader table. */
  formatBar?: (value: number) => string;
  /** A ratio in 0–1, drawn as a meter. Mutually exclusive with `series`. */
  meter?: number;
  /** One line of context under the value. */
  footnote?: React.ReactNode;
  /** Colours the value and the meter. */
  tone?: 'default' | 'success' | 'warning';
  className?: string;
}

const TONE_CLASS = {
  default: '',
  success: 'text-success',
  warning: 'text-warning',
} as const;

const METER_CLASS = {
  default: 'bg-brand',
  success: 'bg-success',
  warning: 'bg-warning',
} as const;

/**
 * One number of the Overview's summary row: a label, the number, and either the
 * period's shape as a bar strip or a ratio as a meter.
 *
 * `role="group"` with the label as its name is what makes a tile addressable —
 * four tiles on a screen otherwise expose four unattributed numbers.
 */
export function StatTile({
  label,
  value,
  series,
  formatBar,
  meter,
  footnote,
  tone = 'default',
  className,
}: StatTileProps) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: the rule suggests <fieldset>, which is for grouping form controls; a tile groups a label, a number and a chart
    <div
      role="group"
      aria-label={label}
      data-slot="stat-tile"
      className={cn('flex flex-col rounded-xl border bg-card px-4 py-3.5 text-card-foreground shadow-sm', className)}
    >
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className={cn('mt-1.5 font-mono font-semibold text-2xl tracking-tight', TONE_CLASS[tone])}>{value}</p>

      {footnote ? <div className="mt-1.5 flex-1 text-muted-foreground text-xs leading-relaxed">{footnote}</div> : null}

      {series ? (
        <BarChart
          className="mt-3"
          data={series}
          height={48}
          label={`${label} per day`}
          format={formatBar}
          data-testid={`stat-tile-series-${label}`}
        />
      ) : null}

      {meter === undefined ? null : (
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className={cn('h-full', METER_CLASS[tone])}
            style={{ width: `${Math.round(Math.min(Math.max(meter, 0), 1) * 100)}%` }}
          />
        </div>
      )}
    </div>
  );
}
