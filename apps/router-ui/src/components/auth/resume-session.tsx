'use client';

import { useQuery } from '@apollo/client/react';
import * as React from 'react';
import { graphql } from '../../generated';
import { completeSignIn } from '../../lib/auth';

/** The cheapest question the API answers: is this browser's session live? */
export const SIGNED_IN_QUERY = graphql(`
  query SignedIn {
    me {
      id
    }
  }
`);

/**
 * Repairs a browser that has a session but no routing marker, and gets it off
 * the sign-in screen.
 *
 * Two ways in never run a line of this app's JavaScript: an OAuth callback and a
 * magic link both come back as a redirect *from router-api*, so the marker
 * `completeSignIn` normally raises was never written and `proxy.ts` sends the
 * browser here — with a live session it cannot see. The sign-in screen is the
 * one place that can notice, and without this the two would take turns for ever.
 *
 * It renders nothing and blocks nothing: the common case is a visitor with no
 * session, who sees the form immediately while the probe fails behind it.
 * `ApolloClientProvider`'s unauthenticated handler swallows that failure —
 * clearing a stale marker on the way — because `/login` is a public path.
 */
export function ResumeSession() {
  const { data } = useQuery(SIGNED_IN_QUERY, { fetchPolicy: 'network-only' });

  React.useEffect(() => {
    if (data?.me) completeSignIn();
  }, [data]);

  return null;
}
