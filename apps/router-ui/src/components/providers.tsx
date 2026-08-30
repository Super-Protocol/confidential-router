'use client';

import type { ApolloLink } from '@apollo/client';
import { Toaster } from '@confidential-router/ui/components/sonner';
import { ThemeProvider } from '@confidential-router/ui/components/theme-provider';
import { useRouter } from 'next/navigation';
import type * as React from 'react';
import { ApolloClientProvider } from '../lib/apollo-client';

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

  return (
    <ThemeProvider>
      <ApolloClientProvider link={link} onUnauthenticated={() => router.replace('/login')}>
        {children}
        <Toaster position="top-right" richColors />
      </ApolloClientProvider>
    </ThemeProvider>
  );
}
