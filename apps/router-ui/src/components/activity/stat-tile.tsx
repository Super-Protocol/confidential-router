import { Card } from '@confidential-router/ui/components/card';
import { Sparkline } from '@confidential-router/ui/components/charts/sparkline';
import { Skeleton } from '@confidential-router/ui/components/skeleton';
import { cn } from '@confidential-router/ui/lib/utils';
import type * as React from 'react';

export interface StatTileProps {
  label: string;
  /** The headline number, already formatted. */
  value: string;
  /** One line under the number — what it is measured over, or its numerator. */
  hint?: React.ReactNode;
  /**
   * Trend for the same period as `value`. Omitted where the API has no series
   * for the metric — a drawn-from-nothing line would be a claim about data that
   * was never returned.
   */
  series?: number[];
  /** Tints the sparkline; defaults to the muted trend colour. */
  accent?: 'muted' | 'brand' | 'success';
}

const ACCENTS: Record<NonNullable<StatTileProps['accent']>, string> = {
  muted: 'text-muted-foreground',
  brand: 'text-brand',
  success: 'text-success',
};

/** One metric of the Activity header row: label, sparkline, number, one hint. */
export function StatTile({ label, value, hint, series, accent = 'muted' }: StatTileProps) {
  return (
    <Card className="gap-0 px-4 py-3.5">
      <div className="flex items-start justify-between gap-3">
        <span className="text-muted-foreground text-sm">{label}</span>
        {series && series.length > 0 ? (
          <Sparkline values={series} label={`${label} trend`} className={cn('shrink-0', ACCENTS[accent])} />
        ) : null}
      </div>
      <p className="mt-1 font-mono font-semibold text-2xl tracking-tight">{value}</p>
      {hint ? <p className="mt-0.5 text-muted-foreground text-xs">{hint}</p> : null}
    </Card>
  );
}

export function StatTileSkeleton({ label }: { label: string }) {
  return (
    <Card className="gap-0 px-4 py-3.5" aria-busy="true">
      <span className="text-muted-foreground text-sm">{label}</span>
      <Skeleton className="mt-1.5 h-7 w-24" />
      <Skeleton className="mt-1.5 h-3 w-32" />
    </Card>
  );
}
