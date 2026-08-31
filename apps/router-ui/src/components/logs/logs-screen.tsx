'use client';

import { useQuery } from '@apollo/client/react';
import { Button } from '@confidential-router/ui/components/button';
import { Card, CardContent } from '@confidential-router/ui/components/card';
import { EmptyState } from '@confidential-router/ui/components/empty-state';
import { ErrorState } from '@confidential-router/ui/components/error-state';
import { Skeleton } from '@confidential-router/ui/components/skeleton';
import { Download, ScrollText } from 'lucide-react';
import * as React from 'react';
import { graphql } from '../../generated';
import { generationsCsvUrl } from '../../lib/generations-csv';
import { formatExact } from '../../lib/metrics';
import { PageHeader } from '../page-header';
import { useSession } from '../session/session-provider';
import { DEFAULT_FILTERS, type LogFilterState, resolveFilters } from './filters';
import { GenerationTable } from './generation-table';
import { LogFilters } from './log-filters';

export const GENERATION_LOG_QUERY = graphql(`
  query GenerationLog(
    $workspaceId: ID!
    $filter: GenerationFilter
    $sort: GenerationSort
    $first: Int!
    $after: String
  ) {
    generations(workspaceId: $workspaceId, filter: $filter, sort: $sort, first: $first, after: $after) {
      totalCount
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        cursor
        node {
          id
          createdAt
          modelId
          modelName
          apiKeyId
          apiKeyName
          promptTokens
          completionTokens
          costMicros
          latencyMs
          timeToFirstTokenMs
          tokensPerSecond
          status
          errorCode
        }
      }
    }
  }
`);

/** What the model and key drop-downs are filled from. */
export const LOG_FILTER_OPTIONS_QUERY = graphql(`
  query LogFilterOptions($workspaceId: ID!) {
    models {
      id
      name
    }
    apiKeys(workspaceId: $workspaceId) {
      id
      name
      prefix
    }
  }
`);

const PAGE_SIZE = 50;

export function LogsScreen() {
  const { activeWorkspace, loading: sessionLoading } = useSession();
  const [filters, setFilters] = React.useState<LogFilterState>(DEFAULT_FILTERS);

  // Pinned for the same reason as on Activity: `from`/`to` key the cache, and a
  // window that moved every render would refetch forever. Re-pinned whenever
  // the viewer touches a control.
  const [now, setNow] = React.useState(() => new Date());

  const workspaceId = activeWorkspace?.id ?? '';
  const { filter, sort, window } = React.useMemo(() => resolveFilters(filters, now), [filters, now]);

  const log = useQuery(GENERATION_LOG_QUERY, {
    variables: { workspaceId, filter, sort, first: PAGE_SIZE },
    skip: workspaceId === '',
    // A page already fetched must not be re-requested when `fetchMore` writes
    // the next one back into the same field.
    notifyOnNetworkStatusChange: true,
  });

  const options = useQuery(LOG_FILTER_OPTIONS_QUERY, { variables: { workspaceId }, skip: workspaceId === '' });

  const onFiltersChange = React.useCallback((next: LogFilterState) => {
    setFilters(next);
    setNow(new Date());
  }, []);

  const connection = log.data?.generations;
  const edges = connection?.edges ?? [];
  const [loadingMore, setLoadingMore] = React.useState(false);

  const loadMore = React.useCallback(async () => {
    const cursor = connection?.pageInfo.endCursor;
    if (!cursor) return;

    setLoadingMore(true);
    try {
      await log.fetchMore({
        variables: { after: cursor },
        // Without this the next page *replaces* the first: `generations` is a
        // plain field to `InMemoryCache`, which has no idea the two responses
        // are halves of one list.
        updateQuery: (previous, { fetchMoreResult }) => ({
          ...fetchMoreResult,
          generations: {
            ...fetchMoreResult.generations,
            edges: [...previous.generations.edges, ...fetchMoreResult.generations.edges],
          },
        }),
      });
    } finally {
      setLoadingMore(false);
    }
  }, [connection, log]);

  const csvUrl =
    workspaceId === ''
      ? undefined
      : generationsCsvUrl({
          workspaceId,
          from: window.from,
          to: window.to,
          modelIds: window.modelIds,
          apiKeyIds: window.apiKeyIds,
          statuses: window.statuses,
        });

  const exportLink = (
    <Button asChild variant="outline" size="sm" aria-disabled={csvUrl === undefined}>
      <a href={csvUrl ?? '#'} download>
        <Download aria-hidden="true" />
        Export CSV
      </a>
    </Button>
  );

  const pending = sessionLoading || (log.loading && connection === undefined);

  return (
    <>
      <PageHeader
        title="Logs"
        description="Metered generations for this workspace. Prompt content is never stored — prompts and completions stay inside the enclave, so there is nothing here to show but the metering."
      />

      <LogFilters
        value={filters}
        onChange={onFiltersChange}
        models={(options.data?.models ?? []).map((model) => ({ id: model.id, label: model.name }))}
        apiKeys={(options.data?.apiKeys ?? []).map((key) => ({ id: key.id, label: `${key.name} · ${key.prefix}` }))}
        action={exportLink}
      />

      {log.error ? (
        <ErrorState
          description="The generation log could not be loaded."
          detail="GenerationLog"
          onRetry={() => void log.refetch()}
        />
      ) : pending ? (
        <Skeleton className="h-96 w-full" role="status" aria-busy="true" aria-label="Loading generations" />
      ) : edges.length === 0 ? (
        <EmptyState
          icon={<ScrollText className="size-5" aria-hidden="true" />}
          title="No generations match these filters"
          description="Widen the range, or clear the model and key filters."
        />
      ) : (
        <Card className="overflow-hidden py-0">
          <CardContent className="px-0">
            <GenerationTable rows={edges.map((edge) => edge.node)} />
          </CardContent>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3">
            <p className="text-muted-foreground text-sm">
              Showing {formatExact(edges.length)} of {formatExact(connection?.totalCount ?? 0)}
            </p>
            {connection?.pageInfo.hasNextPage ? (
              <Button variant="outline" size="sm" disabled={loadingMore} onClick={() => void loadMore()}>
                {loadingMore ? 'Loading…' : 'Load more'}
              </Button>
            ) : null}
          </div>
        </Card>
      )}
    </>
  );
}
