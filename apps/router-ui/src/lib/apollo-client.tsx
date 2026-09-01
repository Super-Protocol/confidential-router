'use client';

import { ApolloClient, ApolloLink, CombinedGraphQLErrors, HttpLink, InMemoryCache } from '@apollo/client';
import { ErrorLink } from '@apollo/client/link/error';
import { ApolloProvider } from '@apollo/client/react';
import * as React from 'react';
import { publicConfig } from './public-config';

/**
 * router-api rejects an unauthenticated operation with a GraphQL error, not a
 * 401 — the HTTP status of a GraphQL response is 200 either way. This is the
 * string its guard raises (SUP-70, `session.guard.ts`).
 */
const UNAUTHENTICATED_MESSAGE = 'Authentication is required';

export function isUnauthenticatedError(error: unknown): boolean {
  return (
    CombinedGraphQLErrors.is(error) &&
    error.errors.some(
      (graphQLError) =>
        graphQLError.extensions?.code === 'UNAUTHENTICATED' || graphQLError.message.includes(UNAUTHENTICATED_MESSAGE),
    )
  );
}

export interface ApolloClientProviderProps {
  children: React.ReactNode;
  /**
   * Replaces the HTTP link. Tests and `/dev/components` pass a mock link so the
   * tree renders without an API; nothing else should.
   */
  link?: ApolloLink;
  /** Called when any operation comes back unauthenticated — wired to a redirect. */
  onUnauthenticated?: () => void;
}

export function createApolloClient(link?: ApolloLink, onUnauthenticated?: () => void): ApolloClient {
  const terminatingLink =
    link ??
    new HttpLink({
      uri: publicConfig().graphqlHttp,
      // The session cookie lives on the API origin.
      credentials: 'include',
    });

  const authLink = new ErrorLink(({ error }) => {
    if (onUnauthenticated && isUnauthenticatedError(error)) onUnauthenticated();
  });

  return new ApolloClient({
    link: ApolloLink.from([authLink, terminatingLink]),
    cache: new InMemoryCache(),
    devtools: { enabled: process.env.NODE_ENV !== 'production' },
  });
}

export function ApolloClientProvider({ children, link, onUnauthenticated }: ApolloClientProviderProps) {
  // A ref, not `useMemo`: recreating the client would drop the cache, and
  // `useMemo` is explicitly allowed to recompute for reasons of its own.
  const clientRef = React.useRef<ApolloClient | null>(null);
  const callbackRef = React.useRef(onUnauthenticated);
  callbackRef.current = onUnauthenticated;

  if (clientRef.current === null) {
    clientRef.current = createApolloClient(link, () => callbackRef.current?.());
  }

  return <ApolloProvider client={clientRef.current}>{children}</ApolloProvider>;
}
