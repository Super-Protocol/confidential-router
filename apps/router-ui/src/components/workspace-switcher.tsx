'use client';

import { Button } from '@confidential-router/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@confidential-router/ui/components/dropdown-menu';
import { Skeleton } from '@confidential-router/ui/components/skeleton';
import { Check, ChevronsUpDown } from 'lucide-react';
import { useSession } from './session/session-provider';

/**
 * Placeholder switcher: it lists the workspaces the session already returns and
 * changes the active one, but creating or renaming a workspace is not a
 * capability the API exposes yet (the contract has no `createWorkspace`). The
 * "New workspace" affordance lands with that mutation.
 */
export function WorkspaceSwitcher() {
  const { workspaces, activeWorkspace, setActiveWorkspaceId, loading } = useSession();

  if (loading && workspaces.length === 0) {
    return <Skeleton className="h-8 w-40" data-testid="workspace-switcher-skeleton" />;
  }

  if (activeWorkspace === null) {
    return <span className="text-muted-foreground text-sm">No workspace</span>;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 gap-1.5 font-normal text-muted-foreground hover:text-foreground"
          aria-label={`Workspace: ${activeWorkspace.name}. Switch workspace`}
        >
          <span className="max-w-40 truncate">{activeWorkspace.name}</span>
          <ChevronsUpDown className="size-3.5 opacity-60" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {workspaces.map((workspace) => (
          <DropdownMenuItem
            key={workspace.id}
            onSelect={() => setActiveWorkspaceId(workspace.id)}
            className="justify-between"
          >
            <span className="truncate">{workspace.name}</span>
            {workspace.id === activeWorkspace.id ? <Check className="size-4" aria-hidden="true" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
