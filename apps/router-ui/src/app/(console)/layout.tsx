import type * as React from 'react';
import { AppShell } from '../../components/app-shell';
import { SessionProvider } from '../../components/session/session-provider';

/**
 * Everything behind the session cookie. `middleware.ts` keeps an unauthenticated
 * browser from reaching these routes at all; `SessionProvider` handles a session
 * that expires while the tab is open.
 */
export default function ConsoleLayout({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <AppShell>{children}</AppShell>
    </SessionProvider>
  );
}
