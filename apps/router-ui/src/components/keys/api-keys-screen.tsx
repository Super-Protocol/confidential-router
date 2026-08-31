'use client';

import { useQuery } from '@apollo/client/react';
import { Button } from '@confidential-router/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@confidential-router/ui/components/card';
import { EmptyState } from '@confidential-router/ui/components/empty-state';
import { ErrorState } from '@confidential-router/ui/components/error-state';
import { Skeleton } from '@confidential-router/ui/components/skeleton';
import { KeyRound, Plus } from 'lucide-react';
import * as React from 'react';
import { PageHeader } from '../page-header';
import { useSession } from '../session/session-provider';
import { ApiKeyTable } from './api-key-table';
import { CreateKeyDialog } from './create-key-dialog';
import { CreatedKeyDialog } from './created-key-dialog';
import { EditKeyDialog } from './edit-key-dialog';
import { API_KEYS_QUERY } from './operations';
import { RevokeKeyDialog } from './revoke-key-dialog';
import type { ApiKeyRow } from './types';
import { WiringSnippet } from './wiring-snippet';

interface CreatedKey {
  secret: string;
  name: string;
}

export function APIKeysScreen() {
  const { activeWorkspace, loading: sessionLoading } = useSession();
  const workspaceId = activeWorkspace?.id ?? null;

  const { data, loading, error, refetch } = useQuery(API_KEYS_QUERY, {
    variables: { workspaceId: workspaceId ?? '' },
    skip: workspaceId === null,
    // Spend and last-used move with every generation; a cache read on
    // navigation would show a limit that has since been reached.
    fetchPolicy: 'cache-and-network',
  });

  const [creating, setCreating] = React.useState(false);
  const [created, setCreated] = React.useState<CreatedKey | null>(null);
  const [editing, setEditing] = React.useState<ApiKeyRow | null>(null);
  const [revoking, setRevoking] = React.useState<ApiKeyRow | null>(null);

  const keys = data?.apiKeys ?? [];
  const models = data?.models ?? [];
  // The snippet has to be runnable as pasted, so it names a real model.
  const sampleModel = models[0]?.id;
  const newestActive = keys.find((apiKey) => apiKey.revokedAt === null);

  const header = (
    <PageHeader
      title="API Keys"
      description="Standard OpenAI-compatible keys. Point them at the router directly, or at a local Gatekeeper that attests the endpoint first."
      actions={
        <Button variant="brand" onClick={() => setCreating(true)} disabled={workspaceId === null}>
          <Plus aria-hidden="true" />
          New key
        </Button>
      }
    />
  );

  return (
    <>
      {header}

      {error ? (
        <ErrorState
          title="The keys could not be loaded"
          description="The console could not read this workspace's keys."
          detail="ApiKeys"
          onRetry={() => void refetch()}
        />
      ) : (loading && keys.length === 0) || sessionLoading ? (
        <div className="space-y-2" data-testid="api-keys-loading">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : keys.length === 0 ? (
        <EmptyState
          icon={<KeyRound className="size-5" aria-hidden="true" />}
          title="No keys yet"
          description="A key is what a client authenticates with. Issue one, scope it to the models it may call, and cap what it may spend."
          action={
            <Button variant="brand" onClick={() => setCreating(true)}>
              <Plus aria-hidden="true" />
              New key
            </Button>
          }
        />
      ) : (
        <ApiKeyTable keys={keys} models={models} onEdit={setEditing} onRevoke={setRevoking} />
      )}

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Wiring an agent</CardTitle>
          <CardDescription>
            Swap the base URL for your local Gatekeeper address and nothing else changes. It resolves the confidential
            endpoint, verifies the evidence it publishes, and only then forwards — same SDK, same model slug, same key.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <WiringSnippet apiKey={newestActive ? `${newestActive.prefix}…` : undefined} model={sampleModel} />
          <p className="mt-3 text-muted-foreground text-xs">
            Keys are stored hashed, so the snippet carries only the visible prefix. Paste the full key you copied when
            it was created.
          </p>
        </CardContent>
      </Card>

      {workspaceId ? (
        <CreateKeyDialog
          open={creating}
          onOpenChange={setCreating}
          workspaceId={workspaceId}
          models={models}
          onCreated={(secret, name) => setCreated({ secret, name })}
        />
      ) : null}

      <CreatedKeyDialog
        secret={created?.secret ?? null}
        name={created?.name ?? ''}
        model={sampleModel}
        onClose={() => setCreated(null)}
      />

      <EditKeyDialog apiKey={editing} models={models} onOpenChange={(open) => !open && setEditing(null)} />

      <RevokeKeyDialog apiKey={revoking} onOpenChange={(open) => !open && setRevoking(null)} />
    </>
  );
}
