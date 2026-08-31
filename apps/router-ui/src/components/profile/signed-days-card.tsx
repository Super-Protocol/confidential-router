import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@confidential-router/ui/components/card';
import { Heatmap } from '@confidential-router/ui/components/charts/heatmap';
import { HEATMAP_DAYS, longestSignedStreak, signedDayCells } from './profile-data';

export interface SignedDaysCardProps {
  /** UTC days on which at least one generation was served with published evidence. */
  signedDays: readonly string[];
  /** Injected in tests so the window does not move under the assertions. */
  now?: Date;
}

/**
 * The contribution graph of days a generation came back alongside evidence the
 * platform had published.
 *
 * It says *published*, never *verified* (ADR-002): this router does not know
 * whether anyone checked a bundle, and a square here is a fact about
 * publication only.
 */
export function SignedDaysCard({ signedDays, now }: SignedDaysCardProps) {
  const cells = signedDayCells(HEATMAP_DAYS, signedDays, now);
  const covered = cells.reduce((total, cell) => total + cell.value, 0);
  const streak = longestSignedStreak(cells.filter((cell) => cell.value > 0).map((cell) => cell.date));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Days with signed responses</CardTitle>
        <CardDescription>
          Days on which at least one generation was served while its endpoint had a fresh evidence bundle published.
          Whether anyone verified it happens in your Gatekeeper, and this router never learns it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <div>
            <dt className="text-muted-foreground text-xs">Longest streak</dt>
            <dd className="font-mono font-semibold text-xl">{streak} days</dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs">Days covered</dt>
            <dd className="font-mono font-semibold text-xl">{covered}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs">Window</dt>
            <dd className="font-mono font-semibold text-xl">{HEATMAP_DAYS} days</dd>
          </div>
        </dl>

        <Heatmap cells={cells} max={1} label={`Days with published evidence over the last ${HEATMAP_DAYS} days`} />

        <div className="flex items-center gap-2 text-muted-foreground text-xs">
          <span>No evidence</span>
          <span className="size-3 rounded-[2px] bg-muted" aria-hidden="true" />
          <span className="size-3 rounded-[2px] bg-brand" aria-hidden="true" />
          <span>Evidence published</span>
        </div>
      </CardContent>
    </Card>
  );
}
