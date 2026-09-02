'use client';

import type { ApolloLink } from '@apollo/client';
import { Toaster } from '@confidential-router/ui/components/sonner';
import { ThemeProvider } from '@confidential-router/ui/components/theme-provider';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { ApolloClientProvider } from '../lib/apollo-client';
import { isPublicPath } from '../lib/public-paths';
import { clearSignedIn } from '../lib/signed-in-cookie';

export interface ProvidersProps {
  children: React.ReactNode;
  /** Test seam: `/dev/components` and the unit tests pass a mock Apollo link. */
  link?: ApolloLink;
}

/**
 * Root providers. Deliberately does not include `SessionProvider` — the sign-in
 * screens live under the same root layout and have no session to fetch.
 */
export function Providers({ children, link }: ProvidersProps) {
  const router = useRouter();

  // The API has the last word on whether a session exists, and this is it
  // saying no: drop the routing marker, or `proxy.ts` would keep bouncing the
  // browser back into a console that answers nothing. The sign-in screens run
  // the same query themselves (`<ResumeSession />`), so a public path only
  // clears the marker — sending it to `/login` from `/login` would be a loop.
  const handleUnauthenticated = React.useCallback(() => {
    clearSignedIn();
    if (!isPublicPath(window.location.pathname)) router.replace('/login');
  }, [router]);

  return (
    <ThemeProvider>
      <ApolloClientProvider link={link} onUnauthenticated={handleUnauthenticated}>
        {children}
        <Toaster position="top-right" richColors />
      </ApolloClientProvider>
    </ThemeProvider>
  );
}
