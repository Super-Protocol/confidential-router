import { formatCount } from './metrics';

/**
 * What `activitySummary` / `activitySeries` / `usageByModel` report about
 * evidence coverage, taken from the API as it comes — including a `null` ratio.
 */
export interface CoverageTotals {
  /** Every generation in the window, external ones included. */
  requests: number;
  /** Of `coverableRequests`, those served while a bundle was published. */
  coveredRequests: number;
  /** The ratio's denominator: generations this deployment's own endpoints served. */
  coverableRequests: number;
  /** Null when `coverableRequests` is 0 — there is no ratio, which is not 0%. */
  evidenceCoverage: number | null;
}

export interface CoverageReading {
  /** For a meter or a sparkline; null when there is no ratio to draw. */
  ratio: number | null;
  /** One short clause, for a tile hint. */
  headline: string;
  /** The full sentence, for a tile footnote with room for it. */
  detail: string;
}

/**
 * What the Evidence-coverage tiles say, in one place because two screens say it
 * and a third puts it in a table column.
 *
 * Coverage answers one question — "did this platform have a fresh bundle
 * published for the endpoint that served this request" — and only this
 * deployment's own endpoints can answer it (ADR-002, ADR-008 §4). A generation
 * routed to an external endpoint is outside the question: the router verified
 * that upstream itself before sending a byte, which is reported in the other
 * vocabulary, "verified by this router".
 *
 * So a window of nothing but external traffic has an empty denominator, and the
 * honest reading is *not applicable* — never `0%`. The console used to print
 * the ratio's numerator over `requests`, which on a production account whose
 * every request was served by a verified external endpoint read "0 of 34
 * generations were served with published evidence": the product's own promise,
 * reported as never once kept (SUP-421).
 */
export function readCoverage(totals: CoverageTotals): CoverageReading {
  const { requests, coveredRequests, coverableRequests, evidenceCoverage } = totals;
  const external = Math.max(requests - coverableRequests, 0);

  if (requests === 0) {
    return {
      ratio: null,
      headline: 'Nothing served in this period',
      detail: 'No generations were served in this period.',
    };
  }

  if (coverableRequests === 0 || evidenceCoverage === null) {
    const served =
      requests === 1
        ? 'the one generation was served by an external endpoint'
        : `all ${formatCount(requests)} generations were served by external endpoints`;
    return {
      ratio: null,
      headline:
        requests === 1
          ? 'Not applicable · one external generation'
          : `Not applicable · all ${formatCount(requests)} served by external endpoints`,
      detail:
        'This platform publishes no bundle for an external endpoint, so coverage does not apply here: ' +
        `${served}, verified by this router before it routed there.`,
    };
  }

  const covered = formatCount(coveredRequests);
  const coverable = formatCount(coverableRequests);
  const published = 'were served while the endpoint had a fresh bundle published';

  if (external === 0) {
    return {
      ratio: evidenceCoverage,
      headline: `${covered} of ${coverable} served with published evidence`,
      detail: `${covered} of ${coverable} generations ${published}.`,
    };
  }

  return {
    ratio: evidenceCoverage,
    headline: `${covered} of ${coverable} on this platform’s endpoints · ${formatCount(external)} external`,
    detail:
      `${covered} of ${coverable} generations on this platform’s own endpoints ${published}. ` +
      `The other ${formatCount(external)} went to external endpoints, verified by this router.`,
  };
}
