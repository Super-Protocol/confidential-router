'use client';

import { useQuery } from '@apollo/client/react';
import { Button } from '@confidential-router/ui/components/button';
import { EmptyState } from '@confidential-router/ui/components/empty-state';
import { ErrorState } from '@confidential-router/ui/components/error-state';
import { Skeleton } from '@confidential-router/ui/components/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@confidential-router/ui/components/tabs';
import { Lock, Plus } from 'lucide-react';
import * as React from 'react';
import { PageHeader } from '../../page-header';
import { useViewerAdminState } from '../../session/use-viewer-is-admin';
import { InviteCodesTab } from './invite-codes-tab';
import { InviteStatsTab, type WindowDays, WindowPicker } from './invite-stats-tab';
import { IssueCodesDialog } from './issue-codes-dialog';
import { INVITE_STATISTICS_QUERY } from './operations';
import { SignUpsTab } from './sign-ups-tab';

const TITLE = 'Invitations';
const DESCRIPTION =
  'Issue invitation codes, see which account came from which code, and how sign-ups are going. Numbers come from this deployment’s own database.';

/**
 * The global admin's Invitations section (SUP-268).
 *
 * Unlike External endpoints and the Trust list, which every member may read
 * (ADR-008 §7), nothing here is for members: codes are bearer credit and the
 * account list is other people's addresses. So a member who finds the URL gets a
 * plain "administrators only" and the screen never asks the API anything — the
 * API refuses those operations to them regardless.
 */
export function InvitationsScreen() {
  const { isAdmin, resolved } = useViewerAdminState();

  if (!resolved) {
    return (
      <>
        <PageHeader title={TITLE} description={DESCRIPTION} />
        <Skeleton className="h-64 w-full" data-testid="invitations-gate-loading" />
      </>
    );
  }

  if (!isAdmin) {
    return (
      <>
        <PageHeader title={TITLE} />
        <EmptyState
          icon={<Lock className="size-5" aria-hidden="true" />}
          title="Administrators only"
          description="Invitation codes and the account list are visible to this deployment’s administrators."
          data-testid="invitations-restricted"
        />
      </>
    );
  }

  return <AdminInvitations />;
}

function AdminInvitations() {
  const [tab, setTab] = React.useState('statistics');
  const [days, setDays] = React.useState<WindowDays>(30);
  const [issuing, setIssuing] = React.useState(false);

  // Read at this level because the codes tab's campaign filter wants the same
  // campaign list the statistics carry; one query, two consumers.
  const statistics = useQuery(INVITE_STATISTICS_QUERY, { variables: { days }, fetchPolicy: 'cache-and-network' });
  const campaigns = React.useMemo(
    () => statistics.data?.inviteStatistics.campaigns.map((entry) => entry.campaign) ?? [],
    [statistics.data],
  );

  return (
    <>
      <PageHeader
        title={TITLE}
        description={DESCRIPTION}
        actions={
          <Button variant="brand" onClick={() => setIssuing(true)}>
            <Plus aria-hidden="true" />
            Issue codes
          </Button>
        }
      />

      <Tabs value={tab} onValueChange={setTab}>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <TabsList>
            <TabsTrigger value="statistics">Statistics</TabsTrigger>
            <TabsTrigger value="codes">Codes</TabsTrigger>
            <TabsTrigger value="sign-ups">Sign-ups</TabsTrigger>
          </TabsList>
          {tab === 'statistics' ? <WindowPicker value={days} onChange={setDays} /> : null}
        </div>

        <TabsContent value="statistics">
          {statistics.error && !statistics.data ? (
            <ErrorState
              title="The statistics could not be loaded"
              description="The console could not read this deployment's invitation numbers."
              detail="InviteStatistics"
              onRetry={() => void statistics.refetch()}
            />
          ) : (
            <InviteStatsTab statistics={statistics.data?.inviteStatistics} days={days} />
          )}
        </TabsContent>
        <TabsContent value="codes">
          <InviteCodesTab campaigns={campaigns} />
        </TabsContent>
        <TabsContent value="sign-ups">
          <SignUpsTab />
        </TabsContent>
      </Tabs>

      <IssueCodesDialog open={issuing} onOpenChange={setIssuing} />
    </>
  );
}
