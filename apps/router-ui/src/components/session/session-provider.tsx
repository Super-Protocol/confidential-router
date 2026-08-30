'use client';

import { useQuery } from '@apollo/client/react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { graphql } from '../../generated';
import type { SessionQuery } from '../../generated/graphql';
import { isUnauthenticatedError } from '../../lib/apollo-client';

export const SESSION_QUERY = graphql(`
  query Session {
    viewer {
      id
      email
      name
      avatarUrl
    }
    workspaces {
      id
      name
      slug
      role
      balance
    }
  }
`);

export type Viewer = SessionQuery['viewer'];
export type Workspace = SessionQuery['workspaces'][number];

export interface SessionValue {
  viewer: Viewer | null;
  workspaces: Workspace[];
  /** The workspace every scoped query is filtered by. */
  activeWorkspace: Workspace | null;
  setActiveWorkspaceId: (id: string) => void;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

const SessionContext = React.createContext<SessionValue | null>(null);

/**
 * Throws outside the provider rather than returning a null session, so a
 * component rendered in the wrong place fails loudly instead of silently
 * pretending nobody is signed in.
 */
export function useSession(): SessionValue {
  const value = React.useContext(SessionContext);
  if (value === null) throw new Error('useSession must be used inside <SessionProvider>');
  return value;
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { data, loading, error, refetch } = useQuery(SESSION_QUERY, {
    // The viewer's balance changes as generations are metered; a stale cache
    // read on navigation is worse than a request.
    fetchPolicy: 'cache-and-network',
  });

  const [activeWorkspaceId, setActiveWorkspaceId] = React.useState<string | null>(null);

  const workspaces = React.useMemo(() => data?.workspaces ?? [], [data]);

  const activeWorkspace = React.useMemo(
    () => workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? workspaces[0] ?? null,
    [workspaces, activeWorkspaceId],
  );

  const value = React.useMemo<SessionValue>(
    () => ({
      viewer: data?.viewer ?? null,
      workspaces,
      activeWorkspace,
      setActiveWorkspaceId,
      loading,
      error: error ?? null,
      refetch: () => {
        void refetch();
      },
    }),
    [data, workspaces, activeWorkspace, loading, error, refetch],
  );

  // A session can expire while the tab is open. The middleware only guards
  // navigations, so a query that comes back unauthenticated is the first place
  // the app learns the cookie is gone.
  React.useEffect(() => {
    if (error && isUnauthenticatedError(error)) router.replace('/login');
  }, [error, router]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
