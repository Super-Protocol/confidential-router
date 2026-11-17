import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@confidential-router/ui/components/card';
import { Heatmap } from '@confidential-router/ui/components/charts/heatmap';
import { type CoverageTotals, readCoverage } from '../../lib/evidence-coverage';
import { HEATMAP_DAYS, longestSignedStreak, signedDayCells } from './profile-data';

export interface SignedDaysCardProps {
  /** UTC days on which at least one generation was served with published evidence. */
  signedDays: readonly string[];
  /** The same window's traffic, which is what says why an empty graph is empty. */
  totals: CoverageTotals;
  /** Injected in tests so the window does not move under the assertions. */
  now?: Date;
}

/**
 * The contribution graph of days a generation came back alongside evidence the
 * platform had published.
 *
 * It says *published*, never *verified* (ADR-002): this router does not know
 * whether anyone acted on a bundle, and a square here is a fact about
 * publication only.
 *
 * An empty graph has two very different causes, and the squares cannot tell
 * them apart: the workspace served nothing, or every generation it served went
 * to an external endpoint — which publishes no bundle of ours, because the
 * router verified that upstream itself (ADR-008 §4). Left alone, the second
 * case reads as six months of "No evidence" to an account whose every request
 * was attested, which is the Overview tile's bug on a second screen (SUP-421).
 * So the window's own totals decide what the card says. A *mixed* window still
 * draws today's graph: every square in it is a true statement about a day, and
 * the legend no longer calls a grey one "No evidence" when the evidence may
 * have been a verdict rather than a publication.
 */
export function SignedDaysCard({ signedDays, totals, now }: SignedDaysCardProps) {
  const cells = signedDayCells(HEATMAP_DAYS, signedDays, now);
  const covered = cells.reduce((total, cell) => total + cell.value, 0);
  const streak = longestSignedStreak(cells.filter((cell) => cell.value > 0).map((cell) => cell.date));
  const coverage = readCoverage(totals);
  // Traffic, but none of it this platform's own to publish for. The graph can
  // only draw zeroes, and zeroes here would be the claim.
  const externalOnly = totals.requests > 0 && totals.coverableRequests === 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Days with signed responses</CardTitle>
        <CardDescription>
          Days on which at least one generation was served while its endpoint had a fresh evidence bundle published.
          Verification happens in your Gatekeeper, and its verdict is never sent to this router.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {externalOnly ? (
          <p className="text-muted-foreground text-sm leading-relaxed">{coverage.detail}</p>
        ) : (
          <>
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
              <span>No evidence published</span>
              <span className="size-3 rounded-[2px] bg-muted" aria-hidden="true" />
              <span className="size-3 rounded-[2px] bg-brand" aria-hidden="true" />
              <span>Evidence published</span>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
