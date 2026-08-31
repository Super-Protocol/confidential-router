import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@confidential-router/ui/components/card';
import { formatUsd, microsToUsd } from '../../lib/format';
import { SPEND_DAYS } from './profile-data';

export interface TopModelUsage {
  modelId: string;
  name: string;
  spendMicros: string;
  requests: number;
}

/**
 * Models by spend, as a bar per model.
 *
 * Scaled against the top model rather than the total, so the second-place model
 * is readable even when the first accounts for most of the bill.
 */
export function TopModelsCard({ usage }: { usage: readonly TopModelUsage[] }) {
  const top = usage.reduce((max, entry) => Math.max(max, microsToUsd(entry.spendMicros)), 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Top models</CardTitle>
        <CardDescription>By spend over the last {SPEND_DAYS} days.</CardDescription>
      </CardHeader>
      <CardContent>
        {usage.length === 0 ? (
          <p className="text-muted-foreground text-sm">Nothing was routed in this period.</p>
        ) : (
          <ul className="space-y-3">
            {usage.map((entry) => {
              const spend = microsToUsd(entry.spendMicros);
              return (
                <li key={entry.modelId} className="space-y-1.5">
                  <div className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="truncate">{entry.name}</span>
                    <span className="font-mono whitespace-nowrap">{formatUsd(entry.spendMicros)}</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-brand"
                      style={{ width: top > 0 ? `${Math.max((spend / top) * 100, 2)}%` : '0%' }}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
