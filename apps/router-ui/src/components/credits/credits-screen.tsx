'use client';

import { useQuery } from '@apollo/client/react';
import { Button } from '@confidential-router/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@confidential-router/ui/components/card';
import { EmptyState } from '@confidential-router/ui/components/empty-state';
import { ErrorState } from '@confidential-router/ui/components/error-state';
import { Skeleton } from '@confidential-router/ui/components/skeleton';
import { Receipt } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';
import { NoWorkspace } from '../no-workspace';
import { PageHeader } from '../page-header';
import { useSession } from '../session/session-provider';
import { AutoTopUpCard } from './auto-top-up-card';
import { BalanceCard } from './balance-card';
import { BuyCreditsCard } from './buy-credits-card';
import { CREDITS_PAGE_SIZE, CREDITS_QUERY } from './operations';
import { type TransactionRow, TransactionTable } from './transaction-table';

/**
 * The Credits screen: balance, top-ups through Stripe Checkout, automatic
 * top-up, and the ledger those write to.
 *
 * The screen never writes credit itself. Both `?topup=success` and
 * `?topup=cancelled` only trigger a refetch, because the money is real when the
 * provider's webhook says so — a viewer who came back from a Checkout tab that
 * Stripe had not finished processing would otherwise be told they had paid.
 */
export function CreditsScreen() {
  const { activeWorkspace, loading: sessionLoading } = useSession();
  const workspaceId = activeWorkspace?.id ?? null;
  const canSpend = activeWorkspace?.role === 'OWNER';

  const { data, loading, error, refetch, fetchMore } = useQuery(CREDITS_QUERY, {
    variables: { workspaceId: workspaceId ?? '', first: CREDITS_PAGE_SIZE },
    skip: workspaceId === null,
    // The balance moves with every generation; a cache read on navigation would
    // show a figure the last few requests have already spent.
    fetchPolicy: 'cache-and-network',
  });

  useCheckoutReturn(refetch);

  const balance = data?.creditBalance ?? null;
  const page = data?.creditTransactions;
  const transactions: TransactionRow[] = React.useMemo(() => (page?.edges ?? []).map((edge) => edge.node), [page]);

  const loadMore = () => {
    if (!page?.pageInfo.hasNextPage) return;
    void fetchMore({
      variables: { after: page.pageInfo.endCursor },
      // The ledger is keyset-paginated, so a page is appended, never merged by
      // index: `creditTransactions` grows and its `pageInfo` is the newest one.
      updateQuery: (previous, { fetchMoreResult }) => ({
        ...fetchMoreResult,
        creditTransactions: {
          ...fetchMoreResult.creditTransactions,
          edges: [...previous.creditTransactions.edges, ...fetchMoreResult.creditTransactions.edges],
        },
      }),
    });
  };

  const header = (
    <PageHeader
      title="Credits"
      description="Prepaid balance for this workspace. Generations are metered inside the enclave and charged against it."
    />
  );

  if (error) {
    return (
      <>
        {header}
        <ErrorState
          title="The balance could not be loaded"
          description="The console could not read this workspace's credits."
          detail="Credits"
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
  // that watched it would drop back to a skeleton with the balance on screen.
  if (balance === null || workspaceId === null) {
    return (
      <>
        {header}
        <div className="space-y-4" data-testid="credits-loading">
          <Skeleton className="h-28 w-full" />
          <div className="grid gap-4 lg:grid-cols-2">
            <Skeleton className="h-64 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      {header}

      <div className="space-y-4">
        <BalanceCard balanceMicros={balance.balanceMicros} spendable={balance.spendable} />

        <div className="grid gap-4 lg:grid-cols-2">
          <BuyCreditsCard workspaceId={workspaceId} minTopUpMicros={balance.minTopUpMicros} canSpend={canSpend} />
          <AutoTopUpCard workspaceId={workspaceId} balance={balance} canSpend={canSpend} />
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Recent transactions</CardTitle>
          </CardHeader>
          <CardContent>
            {transactions.length === 0 ? (
              <EmptyState
                icon={<Receipt className="size-5" aria-hidden="true" />}
                title="No transactions yet"
                description="Purchases, automatic top-ups and the usage each generation is charged for all land here."
              />
            ) : (
              <>
                <TransactionTable transactions={transactions} />
                {page?.pageInfo.hasNextPage ? (
                  <div className="flex justify-center pt-4">
                    <Button variant="outline" size="sm" onClick={loadMore} disabled={loading}>
                      Load more
                    </Button>
                  </div>
                ) : null}
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

/**
 * Handles the return from Stripe Checkout.
 *
 * The parameter is cleared from the URL as soon as it is read, so a reload — or
 * a bookmark of the returned-to page — does not repeat the toast.
 */
function useCheckoutReturn(refetch: () => void): void {
  const router = useRouter();
  const searchParams = useSearchParams();
  const topup = searchParams.get('topup');
  // The effect also re-runs if Apollo hands back a new `refetch`; without this
  // the same return would toast twice before the parameter is gone.
  const handled = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (topup === null || handled.current === topup) return;
    handled.current = topup;

    if (topup === 'success') {
      toast.success('Payment received. The balance updates as soon as Stripe confirms it.');
      refetch();
    } else if (topup === 'cancelled') {
      toast.info('Checkout cancelled. Nothing was charged.');
    }
    router.replace('/credits');
  }, [topup, refetch, router]);
}
