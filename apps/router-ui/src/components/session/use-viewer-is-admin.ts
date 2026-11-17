'use client';

import { useQuery } from '@apollo/client/react';
import { graphql } from '../../generated';

/**
 * Whether this account is in the deployment's `auth.adminEmails` — the only
 * thing the Administration nav group and the admin screens' controls are gated
 * on (ADR-008 §7).
 *
 * Two deliberate choices, both about failure rather than about convenience.
 *
 * **Its own operation, not a field on `SESSION_QUERY`.** `me { isAdmin }` is new
 * in the contract and SUP-225 is what implements it, so a console built from
 * this branch spends a while talking to a router-api whose schema has no such
 * field. Asking for it on the shell's own query would make that a validation
 * error on the one query every page depends on, and the whole console would load
 * without a viewer. It also keeps the extra round trip out of `SessionProvider`,
 * whose context value every screen re-renders on.
 *
 * **`errorPolicy: 'ignore'`, so a failure reads as "not an administrator".**
 * That is the fail-closed answer and the one a browser should assume about
 * itself; the API is what actually refuses a mutation.
 */
export const VIEWER_IS_ADMIN_QUERY = graphql(`
  query ViewerIsAdmin {
    me {
      id
      isAdmin
    }
  }
`);

export function useViewerIsAdmin(): boolean {
  return useViewerAdminState().isAdmin;
}

/**
 * The same answer, plus whether it is in yet — for a screen that is *only* for
 * administrators (SUP-268) and must not flash "restricted" at an operator
 * while the question is still in flight, nor fire its own queries for a member.
 */
export function useViewerAdminState(): { isAdmin: boolean; resolved: boolean } {
  // Not `cache-and-network`: admin membership is deployment configuration, not
  // state that moves while a tab is open.
  const { data, loading } = useQuery(VIEWER_IS_ADMIN_QUERY, { errorPolicy: 'ignore' });
  // Once answered, stays answered: another observer refetching the same query
  // must not flip an open admin screen back to its loading state and unmount it.
  return { isAdmin: data?.me.isAdmin ?? false, resolved: data !== undefined || !loading };
}
