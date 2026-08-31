import { EmptyState } from '@confidential-router/ui/components/empty-state';
import { Building2 } from 'lucide-react';

/**
 * What a workspace-scoped screen shows when the viewer belongs to none.
 *
 * Every credit, key and generation hangs off a workspace, so there is nothing
 * to render and nothing the console can do about it — a workspace is created by
 * an operator, not from here.
 */
export function NoWorkspace() {
  return (
    <EmptyState
      icon={<Building2 className="size-5" aria-hidden="true" />}
      title="No workspace"
      description="This account does not belong to a workspace yet. Ask an operator to add you to one; everything on this screen is scoped to it."
    />
  );
}
