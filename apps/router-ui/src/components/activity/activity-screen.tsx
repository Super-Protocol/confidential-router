'use client';

import { useQuery } from '@apollo/client/react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@confidential-router/ui/components/card';
import { StackedBarChart } from '@confidential-router/ui/components/charts/stacked-bar-chart';
import { ErrorState } from '@confidential-router/ui/components/error-state';
import { Skeleton } from '@confidential-router/ui/components/skeleton';
import * as React from 'react';
import { graphql } from '../../generated';
import { formatUsd, microsToUsd } from '../../lib/format';
import { formatCount, formatMs, formatRatio, formatTokensPerSecond } from '../../lib/metrics';
import {
  DEFAULT_RANGE,
  formatBucketLabel,
  RANGE_OPTIONS,
  type RangeKey,
  resolveDays,
  resolveRange,
  USAGE_BY_MODEL_DAYS,
} from '../../lib/ranges';
import { PageHeader } from '../page-header';
import { useSession } from '../session/session-provider';
import { RangePicker } from './range-picker';
import { StatTile, StatTileSkeleton } from './stat-tile';
import { TopKeysCard } from './top-keys-card';
import { UsageByModelCard } from './usage-by-model-card';

/**
 * Everything the range picker drives, in one round trip. Splitting it would put
 * the tiles and the chart under them on different clocks, which is exactly the
 * inconsistency the summary/series pair exists to avoid.
 */
export const ACTIVITY_QUERY = graphql(`
  query Activity($workspaceId: ID!, $from: DateTime!, $to: DateTime!, $bucket: Bucket!) {
    activitySummary(workspaceId: $workspaceId, from: $from, to: $to) {
      spendMicros
      requests
      promptTokens
      completionTokens
      coveredRequests
      evidenceCoverage
      avgTimeToFirstTokenMs
      avgTokensPerSecond
      timedRequests
      ratedRequests
    }
    activitySeries(workspaceId: $workspaceId, from: $from, to: $to, bucket: $bucket) {
      bucket
      spendMicros
      requests
      promptTokens
      completionTokens
      evidenceCoverage
    }
    topKeys(workspaceId: $workspaceId, from: $from, to: $to, limit: 5) {
      apiKeyId
      name
      prefix
      requests
      promptTokens
      completionTokens
      spendMicros
    }
  }
`);

/** Separate because its window is fixed at 30 days — see `UsageByModelCard`. */
export const ACTIVITY_USAGE_BY_MODEL_QUERY = graphql(`
  query ActivityUsageByModel($workspaceId: ID!, $from: DateTime!, $to: DateTime!, $limit: Int) {
    usageByModel(workspaceId: $workspaceId, from: $from, to: $to, limit: $limit) {
      modelId
      name
      requests
      promptTokens
      completionTokens
      spendMicros
      evidenceCoverage
    }
  }
`);

/** More than eight columns of model name is unreadable at any console width. */
const MODEL_LIMIT = 8;

const TILE_LABELS = ['Total spend', 'Requests', 'Token volume', 'Time to first token', 'Evidence coverage'];

/**
 * What the two means in the time-to-first-token tile are averages *over*.
 *
 * Neither is over every request, and they are not over the same ones. A request
 * that was not streamed has no first token to time; a rate additionally needs a
 * window large enough to divide (`tokensPerSecond` in the API), so `ratedRequests`
 * is a strict subset of `timedRequests` — an agent's short tool-call turn is
 * timed and unrated. The tile used to print both under one bare "Average", which
 * read as a claim about the whole period (SUP-424), so each mean now names its
 * own sample — the rate only repeats the count when it differs from the
 * first-token one, and carries the total itself when the first clause printed
 * none to read it against.
 */
function timeToFirstTokenHint(summary: {
  requests: number;
  timedRequests: number;
  ratedRequests: number;
  avgTokensPerSecond: number | null;
}): string {
  if (summary.timedRequests === 0) {
    return 'No request reported a first token';
  }
  const sample =
    summary.timedRequests >= summary.requests
      ? 'Average across the period'
      : `Average of ${formatCount(summary.timedRequests)} of ${formatCount(summary.requests)} requests`;

  if (summary.avgTokensPerSecond === null) {
    return sample;
  }
  const rate = formatTokensPerSecond(summary.avgTokensPerSecond);
  if (summary.ratedRequests >= summary.timedRequests) {
    // One sample behind both means, and `sample` has already named it.
    return `${sample} · ${rate}`;
  }
  // Fewer rated than timed, so the rate states its own count — with the total
  // when `sample` is "Average across the period" and prints none to read it
  // against, and without when it already says "of 842 requests".
  const over =
    summary.timedRequests >= summary.requests
      ? `${formatCount(summary.ratedRequests)} of ${formatCount(summary.requests)}`
      : formatCount(summary.ratedRequests);

  return `${sample} · ${rate} over ${over}`;
}

const SERIES = [
  { key: 'completionTokens', label: 'Output tokens' },
  { key: 'promptTokens', label: 'Input tokens' },
];

export function ActivityScreen() {
  const { activeWorkspace, loading: sessionLoading } = useSession();
  const [range, setRange] = React.useState<RangeKey>(DEFAULT_RANGE);

  // Pinned, not read on every render: `from`/`to` key the Apollo cache, and a
  // value that moved each render would make every render a cache miss. It is
  // re-pinned when the viewer picks a range, which is also the one moment they
  // expect fresh numbers.
  const [now, setNow] = React.useState(() => new Date());

  const workspaceId = activeWorkspace?.id ?? '';
  const { from, to, bucket } = React.useMemo(() => resolveRange(range, now), [range, now]);
  const modelWindow = React.useMemo(() => resolveDays(USAGE_BY_MODEL_DAYS, now), [now]);

  const activity = useQuery(ACTIVITY_QUERY, {
    variables: { workspaceId, from, to, bucket },
    skip: workspaceId === '',
  });

  const usage = useQuery(ACTIVITY_USAGE_BY_MODEL_QUERY, {
    variables: { workspaceId, from: modelWindow.from, to: modelWindow.to, limit: MODEL_LIMIT },
    skip: workspaceId === '',
  });

  const onRangeChange = React.useCallback((key: RangeKey) => {
    setRange(key);
    setNow(new Date());
  }, []);

  const header = (
    <PageHeader
      title="Activity"
      description="Your usage across confidential models."
      actions={<RangePicker value={range} onChange={onRangeChange} />}
    />
  );

  if (activity.error) {
    return (
      <>
        {header}
        <ErrorState
          description="Activity could not be loaded for this period."
          detail="Activity"
          onRetry={() => void activity.refetch()}
        />
      </>
    );
  }

  const summary = activity.data?.activitySummary;
  const series = activity.data?.activitySeries ?? [];
  const pending = sessionLoading || activity.loading || summary === undefined;

  const points = series.map((point) => ({
    // The hourly label repeats across a rolling 24-hour window; the bucket start
    // is what actually identifies a column.
    id: point.bucket,
    label: formatBucketLabel(bucket, point.bucket),
    values: { promptTokens: point.promptTokens, completionTokens: point.completionTokens },
  }));

  return (
    <>
      {header}

      <div className="mb-6 grid gap-3.5 sm:grid-cols-2 xl:grid-cols-5">
        {pending ? (
          TILE_LABELS.map((label) => <StatTileSkeleton key={label} label={label} />)
        ) : (
          <>
            <StatTile
              label="Total spend"
              value={formatUsd(summary.spendMicros)}
              hint={RANGE_OPTIONS[range].long}
              series={series.map((point) => microsToUsd(point.spendMicros))}
            />
            <StatTile
              label="Requests"
              value={formatCount(summary.requests)}
              hint={RANGE_OPTIONS[range].long}
              series={series.map((point) => point.requests)}
            />
            <StatTile
              label="Token volume"
              value={formatCount(summary.promptTokens + summary.completionTokens)}
              hint={`${formatCount(summary.promptTokens)} in · ${formatCount(summary.completionTokens)} out`}
              series={series.map((point) => point.promptTokens + point.completionTokens)}
            />
            <StatTile
              label="Time to first token"
              // `activitySeries` carries no latency, so this tile has no
              // sparkline rather than one drawn from a neighbouring metric.
              value={formatMs(summary.avgTimeToFirstTokenMs)}
              hint={timeToFirstTokenHint(summary)}
            />
            <StatTile
              label="Evidence coverage"
              value={formatRatio(summary.evidenceCoverage)}
              hint={`${formatCount(summary.coveredRequests)} of ${formatCount(summary.requests)} served with published evidence`}
              accent="success"
              series={series.map((point) => point.evidenceCoverage)}
            />
          </>
        )}
      </div>

      <Card className="mb-6">
        <CardHeader className="border-b pb-4">
          <CardTitle className="text-sm">Token volume over time</CardTitle>
          <CardDescription>
            {RANGE_OPTIONS[range].long}, bucketed by {bucket === 'HOUR' ? 'hour' : 'day'}.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {pending ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <StackedBarChart
              data={points}
              series={SERIES}
              label={`Tokens per ${bucket === 'HOUR' ? 'hour' : 'day'}, ${RANGE_OPTIONS[range].long.toLowerCase()}`}
              format={formatCount}
              axis="sparse"
            />
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        {pending ? <Skeleton className="h-72" /> : <TopKeysCard keys={activity.data?.topKeys ?? []} />}
        {usage.error ? (
          // Its own failure, because its window is its own query: the tiles
          // above are still true when the 30-day breakdown is not available.
          <ErrorState
            description="Usage by model could not be loaded."
            detail="ActivityUsageByModel"
            onRetry={() => void usage.refetch()}
          />
        ) : usage.loading || usage.data === undefined ? (
          <Skeleton className="h-72" />
        ) : (
          <UsageByModelCard models={usage.data.usageByModel} />
        )}
      </div>
    </>
  );
}
