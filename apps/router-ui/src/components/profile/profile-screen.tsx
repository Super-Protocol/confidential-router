'use client';

import { useQuery } from '@apollo/client/react';
import { ErrorState } from '@confidential-router/ui/components/error-state';
import { Skeleton } from '@confidential-router/ui/components/skeleton';
import * as React from 'react';
import { lastUtcDays } from '../../lib/date-range';
import { NoWorkspace } from '../no-workspace';
import { PageHeader } from '../page-header';
import { useSession } from '../session/session-provider';
import { AccountCard } from './account-card';
import { PROFILE_QUERY } from './operations';
import { HEATMAP_DAYS, SPEND_DAYS } from './profile-data';
import { SignedDaysCard } from './signed-days-card';
import { SpendCard } from './spend-card';
import { TopModelsCard } from './top-models-card';

export function ProfileScreen() {
  const { activeWorkspace, loading: sessionLoading } = useSession();
  const workspaceId = activeWorkspace?.id ?? null;

  // Frozen for the life of the mount: a range recomputed on every render would
  // change the query variables and refetch the screen in a loop.
  const range = React.useMemo(() => lastUtcDays(SPEND_DAYS), []);

  const { data, error, refetch } = useQuery(PROFILE_QUERY, {
    variables: { workspaceId: workspaceId ?? '', ...range, heatmapDays: HEATMAP_DAYS },
    skip: workspaceId === null,
    fetchPolicy: 'cache-and-network',
  });

  const header = (
    <PageHeader
      title="Profile"
      description="Your account, what this workspace spent, and how much of it came with published evidence."
    />
  );

  if (error) {
    return (
      <>
        {header}
        <ErrorState
          title="The profile could not be loaded"
          description="The console could not read your account or this workspace's usage."
          detail="Profile"
          onRetry={() => void refetch()}
        />
      </>
    );
  }

  if (workspaceId === null && !sessionLoading) {
    return (
      <>
        {header}
        <NoWorkspace />
      </>
    );
  }

  // Deliberately not keyed on the session's `loading`: the shell's query is
  // `cache-and-network`, so it goes loading again on every refetch, and a screen
  // that watched it would drop back to a skeleton with the data still on screen.
  if (!data) {
    return (
      <>
        {header}
        <div className="space-y-4" data-testid="profile-loading">
          <Skeleton className="h-32 w-full" />
          <div className="grid gap-4 lg:grid-cols-2">
            <Skeleton className="h-64 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
          <Skeleton className="h-56 w-full" />
        </div>
      </>
    );
  }

  return (
    <>
      {header}

      <div className="space-y-4">
        <AccountCard
          name={data.me.name ?? null}
          email={data.me.email}
          avatarUrl={data.me.avatarUrl ?? null}
          createdAt={data.me.createdAt}
        />

        <div className="grid gap-4 lg:grid-cols-2">
          <SpendCard points={data.activitySeries} />
          <TopModelsCard usage={data.usageByModel} />
        </div>

        <SignedDaysCard signedDays={data.signedResponseDays} />
      </div>
    </>
  );
}
