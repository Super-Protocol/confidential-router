'use client';

import { useQuery } from '@apollo/client/react';
import { CopyButton } from '@confidential-router/ui/components/copy-button';
import { EmptyState } from '@confidential-router/ui/components/empty-state';
import { ErrorState } from '@confidential-router/ui/components/error-state';
import { Skeleton } from '@confidential-router/ui/components/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@confidential-router/ui/components/table';
import { ServerOff } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';
import { graphql } from '../../generated';
import { formatBucketLabel, lastUtcDays } from '../../lib/date-range';
import { formatCompact, formatPercent, formatUsd, microsToUsd, shortenDigest } from '../../lib/format';
import { EvidenceBadge } from '../evidence/evidence-badge';
import { useSession } from '../session/session-provider';
import { StatTile } from '../stat-tile';

/** The period the summary row covers — the prototype's "This week's usage". */
const PERIOD_DAYS = 7;

export const OVERVIEW_QUERY = graphql(`
  query Overview($workspaceId: ID!, $from: DateTime!, $to: DateTime!) {
    activitySummary(workspaceId: $workspaceId, from: $from, to: $to) {
      spendMicros
      requests
      promptTokens
      completionTokens
      coveredRequests
      evidenceCoverage
    }
    activitySeries(workspaceId: $workspaceId, from: $from, to: $to, bucket: DAY) {
      bucket
      spendMicros
      requests
      promptTokens
      completionTokens
    }
    endpoints(workspaceId: $workspaceId) {
      ...EndpointEvidenceFields
      tokensRouted30d
    }
  }
`);

function TilesSkeleton() {
  return (
    <div className="grid gap-3.5 sm:grid-cols-2 xl:grid-cols-4" aria-hidden="true">
      {['spend', 'requests', 'tokens', 'coverage'].map((key) => (
        <Skeleton key={key} className="h-32" />
      ))}
    </div>
  );
}

/**
 * Spend, traffic and evidence coverage for the last seven days, and the
 * endpoints the workspace's traffic went to.
 *
 * One query, because all four tiles and the table are one screen: splitting
 * them would show a page that finishes loading in four places.
 */
export function OverviewScreen() {
  const { activeWorkspace, loading: sessionLoading } = useSession();
  const workspaceId = activeWorkspace?.id;

  // Recomputed only when the UTC day rolls over — see `lastUtcDays`.
  const range = React.useMemo(() => lastUtcDays(PERIOD_DAYS), []);

  const { data, loading, error, refetch } = useQuery(OVERVIEW_QUERY, {
    variables: { workspaceId: workspaceId ?? '', from: range.from, to: range.to },
    skip: !workspaceId,
    fetchPolicy: 'cache-and-network',
  });

  if (error && !data) {
    return (
      <ErrorState
        description="The workspace's usage and endpoints could not be loaded."
        onRetry={() => {
          void refetch();
        }}
      />
    );
  }

  if (!data) {
    return (
      <div className="space-y-6">
        <TilesSkeleton />
        <Skeleton className="h-56" aria-hidden="true" />
        <span className="sr-only" role="status" aria-busy={sessionLoading || loading}>
          Loading workspace usage
        </span>
      </div>
    );
  }

  const { activitySummary: summary, activitySeries: series, endpoints } = data;
  const tokens = summary.promptTokens + summary.completionTokens;

  const bars = series.map((point) => ({ label: formatBucketLabel(point.bucket), point }));

  return (
    <div className="space-y-6">
      <section aria-labelledby="usage-heading">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 id="usage-heading" className="font-semibold text-[15px]">
            This week’s usage
          </h2>
          <Link href="/activity" className="text-muted-foreground text-sm hover:text-foreground">
            View activity →
          </Link>
        </div>

        <div className="grid gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
          <StatTile
            label="Spend"
            value={formatUsd(summary.spendMicros)}
            series={bars.map(({ label, point }) => ({ label, value: microsToUsd(point.spendMicros) }))}
            formatBar={(value) => `$${value.toFixed(2)}`}
          />
          <StatTile
            label="Requests"
            value={formatCompact(summary.requests)}
            series={bars.map(({ label, point }) => ({ label, value: point.requests }))}
            formatBar={formatCompact}
          />
          <StatTile
            label="Tokens"
            value={formatCompact(tokens)}
            series={bars.map(({ label, point }) => ({
              label,
              value: point.promptTokens + point.completionTokens,
            }))}
            formatBar={formatCompact}
          />
          {/*
            Coverage is a fact about publication, never a verification rate
            (ADR-002): of the generations served this week, how many were served
            while the platform had a fresh bundle up for the endpoint serving
            them.
          */}
          <StatTile
            label="Evidence coverage"
            value={formatPercent(summary.evidenceCoverage)}
            tone={summary.requests > 0 && summary.evidenceCoverage === 1 ? 'success' : 'default'}
            meter={summary.evidenceCoverage}
            footnote={
              summary.requests === 0
                ? 'No generations were served in this period.'
                : `${formatCompact(summary.coveredRequests)} of ${formatCompact(summary.requests)} generations were served while the endpoint had a fresh bundle published.`
            }
          />
        </div>
      </section>

      <section aria-labelledby="endpoints-heading">
        <h2 id="endpoints-heading" className="mb-3 font-semibold text-[15px]">
          Your confidential endpoints
        </h2>

        {endpoints.length === 0 ? (
          <EmptyState
            icon={<ServerOff className="size-5" aria-hidden="true" />}
            title="No endpoints yet"
            description="This router publishes no endpoints for this workspace. They appear here as soon as the router config declares one."
          />
        ) : (
          <div className="overflow-x-auto rounded-xl border">
            <Table aria-label="Confidential endpoints">
              <TableHeader>
                <TableRow>
                  <TableHead className="px-4">Endpoint</TableHead>
                  <TableHead>TEE</TableHead>
                  <TableHead>Evidence digest</TableHead>
                  <TableHead>Evidence</TableHead>
                  <TableHead className="px-4 text-right">Tokens (30d)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {endpoints.map((endpoint) => (
                  <TableRow key={endpoint.id}>
                    <TableCell className="px-4">
                      <span className="font-mono text-xs">{endpoint.hostname}</span>
                      <span className="block text-muted-foreground text-xs">{endpoint.name}</span>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">{endpoint.tee}</TableCell>
                    <TableCell>
                      {endpoint.latestEvidence ? (
                        <span className="inline-flex items-center gap-1.5">
                          <span className="font-mono text-xs" title={endpoint.latestEvidence.evidenceDigest}>
                            {shortenDigest(endpoint.latestEvidence.evidenceDigest)}
                          </span>
                          {/*
                            The digest is the value a user pins in their
                            gatekeeper (`endpoint trust add`), so it is shown
                            truncated and copied in full.
                          */}
                          <CopyButton
                            value={endpoint.latestEvidence.evidenceDigest}
                            label={`Copy evidence digest for ${endpoint.hostname}`}
                          />
                        </span>
                      ) : (
                        <span className="text-muted-foreground text-xs">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <EvidenceBadge
                        endpoint={endpoint}
                        onRefreshed={() => {
                          void refetch();
                        }}
                      />
                    </TableCell>
                    <TableCell className="px-4 text-right font-mono text-xs">
                      {formatCompact(endpoint.tokensRouted30d)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </div>
  );
}
