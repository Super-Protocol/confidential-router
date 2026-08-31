import { formatCompact, formatUsd } from '../../lib/format';
import { StatTile } from '../stat-tile';
import { SPEND_DAYS, type SpendPoint, spendBars, totalMicros } from './profile-data';

export interface SpendCardProps {
  points: readonly (SpendPoint & { requests: number; promptTokens: number; completionTokens: number })[];
}

/**
 * The last week in three tiles, the same ones Overview uses — a viewer who has
 * read one screen does not have to learn a second layout for the same numbers.
 */
export function SpendCard({ points }: SpendCardProps) {
  const spend = totalMicros(points);
  const requests = points.reduce((total, point) => total + point.requests, 0);
  const tokens = points.reduce((total, point) => total + point.promptTokens + point.completionTokens, 0);

  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <StatTile
        label="Spend"
        value={formatUsd(spend)}
        footnote={`Last ${SPEND_DAYS} days`}
        series={spendBars(points)}
        formatBar={(value) => `$${value.toFixed(2)}`}
      />
      <StatTile label="Requests" value={formatCompact(requests)} footnote={`Last ${SPEND_DAYS} days`} />
      <StatTile label="Tokens" value={formatCompact(tokens)} footnote="Prompt and completion" />
    </div>
  );
}
