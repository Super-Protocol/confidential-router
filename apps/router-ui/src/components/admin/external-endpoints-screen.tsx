'use client';

import { useMutation, useQuery } from '@apollo/client/react';
import { Badge } from '@confidential-router/ui/components/badge';
import { Button } from '@confidential-router/ui/components/button';
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
import { Globe, Plus } from 'lucide-react';
import * as React from 'react';
import type { ExternalEndpointFieldsFragment } from '../../generated/graphql';
import { formatTimestamp, shortenDigest } from '../../lib/format';
import { errorMessageOf } from '../../lib/graphql-error';
import { PageHeader } from '../page-header';
import { useViewerIsAdmin } from '../session/use-viewer-is-admin';
import { AdminReadOnlyNotice } from './admin-gate';
import { EndpointDrawer } from './endpoint-drawer';
import { STATUS_ORDER, statusPresentation } from './endpoint-status';
import { EXTERNAL_ENDPOINTS_QUERY, SET_EXTERNAL_ENDPOINT_ENABLED } from './operations';
import { RegisterEndpointDialog } from './register-endpoint-dialog';
import { RotateKeyDialog } from './rotate-key-dialog';

/**
 * Denied first, then pending, then verified, then disabled — and alphabetically
 * inside a group. An operator opens this screen because something is wrong, so
 * the rows that need them are at the top rather than wherever registration order
 * put them.
 */
export function sortEndpoints(endpoints: readonly ExternalEndpointFieldsFragment[]): ExternalEndpointFieldsFragment[] {
  return [...endpoints].sort((left, right) => {
    const byStatus = STATUS_ORDER.indexOf(left.status) - STATUS_ORDER.indexOf(right.status);
    return byStatus !== 0 ? byStatus : left.name.localeCompare(right.name);
  });
}

export function ExternalEndpointsScreen() {
  /*
   * Only the admin flag — these two screens are not workspace-scoped, so there
   * is nothing here to wait for a session for. Gating the table on the session's
   * `loading` would blank the screen on every session refetch, unmounting the
   * row a reader was about to click. Until the flag arrives `isAdmin` is false,
   * which is the fail-closed default anyway.
   */
  const isAdmin = useViewerIsAdmin();

  const { data, loading, error, refetch } = useQuery(EXTERNAL_ENDPOINTS_QUERY, {
    // A verdict flips on the sidecar's own schedule, so a cache read on
    // navigation can show an endpoint as routable after it stopped being.
    fetchPolicy: 'cache-and-network',
  });

  const [registering, setRegistering] = React.useState(false);
  const [openEndpointId, setOpenEndpointId] = React.useState<string | null>(null);
  const [rotatingId, setRotatingId] = React.useState<string | null>(null);
  const [actionFailure, setActionFailure] = React.useState<string | null>(null);

  const [setEnabled] = useMutation(SET_EXTERNAL_ENDPOINT_ENABLED);
  /*
   * Which row is mid-flight, rather than the mutation's own `loading`. That flag
   * is global to the hook, so one disable would grey out every other row's
   * button — on a screen whose whole job is reacting to several upstreams at
   * once.
   */
  const [togglingId, setTogglingId] = React.useState<string | null>(null);

  const endpoints = React.useMemo(() => sortEndpoints(data?.externalEndpoints ?? []), [data]);
  const openEndpoint = endpoints.find((endpoint) => endpoint.id === openEndpointId) ?? null;
  const rotating = endpoints.find((endpoint) => endpoint.id === rotatingId) ?? null;

  const toggle = async (endpoint: ExternalEndpointFieldsFragment) => {
    setActionFailure(null);
    setTogglingId(endpoint.id);
    try {
      await setEnabled({ variables: { id: endpoint.id, input: { enabled: !endpoint.enabled } } });
    } catch (caught) {
      setActionFailure(errorMessageOf(caught));
    } finally {
      setTogglingId(null);
    }
  };

  const header = (
    <PageHeader
      title="External endpoints"
      description="Models served by other deployments. This router verifies each one's evidence against the trust list and pins its certificate before proxying a single prompt; a failed check drops its models immediately."
      actions={
        isAdmin ? (
          <Button variant="brand" onClick={() => setRegistering(true)}>
            <Plus aria-hidden="true" />
            Add external endpoint
          </Button>
        ) : null
      }
    />
  );

  if (error && !data) {
    return (
      <>
        {header}
        <ErrorState
          title="The external endpoints could not be loaded"
          description="The console could not read this deployment's external endpoints."
          detail="ExternalEndpoints"
          onRetry={() => void refetch()}
        />
      </>
    );
  }

  return (
    <>
      {header}

      {isAdmin ? null : <AdminReadOnlyNotice className="mb-4" />}

      {actionFailure ? (
        <p role="alert" className="mb-4 text-destructive text-sm">
          {actionFailure}
        </p>
      ) : null}

      {loading && endpoints.length === 0 ? (
        <div className="space-y-2" data-testid="external-endpoints-loading">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : endpoints.length === 0 ? (
        <EmptyState
          icon={<Globe className="size-5" aria-hidden="true" />}
          title="No external endpoints"
          description="Every model this router serves today runs inside its own cluster space. Register an upstream to serve a model from another deployment — it will not route until this router has verified it."
          action={
            isAdmin ? (
              <Button variant="brand" onClick={() => setRegistering(true)}>
                <Plus aria-hidden="true" />
                Add external endpoint
              </Button>
            ) : null
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Endpoint</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Measurement seen</TableHead>
                <TableHead>Models</TableHead>
                <TableHead>Last check</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {endpoints.map((endpoint) => {
                const presentation = statusPresentation(endpoint.status);
                return (
                  <TableRow key={endpoint.id}>
                    <TableCell>
                      <button
                        type="button"
                        onClick={() => setOpenEndpointId(endpoint.id)}
                        className="rounded-md text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                        aria-label={`Open ${endpoint.name}: evidence summary and verdict timeline`}
                      >
                        <span className="font-medium text-sm hover:underline">{endpoint.name}</span>
                        <span className="block font-mono text-muted-foreground text-xs">{endpoint.hostname}</span>
                      </button>
                    </TableCell>
                    <TableCell>
                      <Badge variant={presentation.variant}>{presentation.label}</Badge>
                      {endpoint.lastReason ? (
                        <span className="mt-1 block max-w-60 text-muted-foreground text-xs">{endpoint.lastReason}</span>
                      ) : null}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {endpoint.measurementSeen ? (
                        <span title={endpoint.measurementSeen}>{shortenDigest(endpoint.measurementSeen, 6)}</span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">{endpoint.models.length}</TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {endpoint.lastCheckedAt ? formatTimestamp(endpoint.lastCheckedAt) : 'Never'}
                    </TableCell>
                    <TableCell className="text-right">
                      {isAdmin ? (
                        <div className="flex justify-end gap-1.5">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={togglingId === endpoint.id}
                            onClick={() => void toggle(endpoint)}
                          >
                            {endpoint.enabled ? 'Disable' : 'Enable'}
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => setRotatingId(endpoint.id)}>
                            Rotate key
                          </Button>
                        </div>
                      ) : (
                        <Button variant="ghost" size="sm" onClick={() => setOpenEndpointId(endpoint.id)}>
                          Details
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {isAdmin ? (
        <RegisterEndpointDialog
          open={registering}
          onOpenChange={setRegistering}
          // Ruling 1: the evidence summary is seen *at registration*, so the
          // drawer opens on the endpoint the admin just created rather than
          // leaving them to find it in the list.
          onRegistered={setOpenEndpointId}
        />
      ) : null}

      <EndpointDrawer
        endpoint={openEndpoint}
        isAdmin={isAdmin}
        onOpenChange={(open) => !open && setOpenEndpointId(null)}
      />

      {/* `key` so the typed secret cannot survive into another endpoint's dialog. */}
      {isAdmin ? (
        <RotateKeyDialog key={rotating?.id} endpoint={rotating} onOpenChange={(open) => !open && setRotatingId(null)} />
      ) : null}
    </>
  );
}
