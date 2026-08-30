'use client';

import { Button } from '@confidential-router/ui/components/button';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@confidential-router/ui/components/sheet';
import { Menu } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import * as React from 'react';
import { BrandMark } from './brand-mark';
import { AppBreadcrumbs } from './breadcrumbs';
import { SidebarNav } from './sidebar-nav';
import { ThemeToggle } from './theme-toggle';
import { UserMenu } from './user-menu';

function SidebarHeader() {
  return (
    <div className="flex items-center gap-2.5 border-sidebar-border border-b px-4 py-3.5">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-brand text-brand-foreground">
        <BrandMark className="size-4" />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-semibold text-sm leading-tight">Confidential Router</span>
        <span className="font-mono text-[0.65rem] text-muted-foreground leading-tight">confidential inference</span>
      </span>
    </div>
  );
}

/**
 * Sidebar + breadcrumb header, ported from the layout pattern of swarm-cloud
 * `apps/swarm-cloud-ui/src/components/app-shell.tsx`.
 *
 * Deviation: the responsive behaviour. swarm-cloud collapses its sidebar to an
 * icon rail; the prototype's grouped nav does not survive that, so below `lg`
 * the sidebar becomes a drawer instead. Nothing is hidden at any width.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = React.useState(false);

  // A drawer that stays open across a navigation covers the page the viewer
  // just asked for.
  // biome-ignore lint/correctness/useExhaustiveDependencies: closing on pathname change is the point
  React.useEffect(() => setDrawerOpen(false), [pathname]);

  return (
    <div className="flex min-h-svh bg-background text-foreground">
      <a
        href="#main-content"
        className="-translate-y-full sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:translate-y-0 focus:rounded-md focus:bg-popover focus:px-3 focus:py-2 focus:text-sm focus:ring-[3px] focus:ring-ring/50"
      >
        Skip to content
      </a>

      <aside className="sticky top-0 hidden h-svh w-[236px] shrink-0 flex-col border-sidebar-border border-r bg-sidebar lg:flex">
        <SidebarHeader />
        <div className="flex-1 overflow-y-auto">
          <SidebarNav />
        </div>
        <div className="border-sidebar-border border-t p-2">
          <UserMenu />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex h-13 shrink-0 items-center gap-3 border-border border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/75 lg:px-7">
          <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open navigation">
                <Menu className="size-4" aria-hidden="true" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-[260px] bg-sidebar p-0">
              <SheetTitle className="sr-only">Console navigation</SheetTitle>
              <SidebarHeader />
              <div className="flex-1 overflow-y-auto">
                <SidebarNav onNavigate={() => setDrawerOpen(false)} />
              </div>
              <div className="border-sidebar-border border-t p-2">
                <UserMenu />
              </div>
            </SheetContent>
          </Sheet>

          <AppBreadcrumbs />

          <div className="ml-auto flex items-center gap-1.5">
            <Button variant="outline" size="sm" asChild className="hidden sm:inline-flex">
              <Link href="/gatekeeper">
                <BrandMark className="size-3.5 text-brand-emphasis" />
                Verify with Gatekeeper
              </Link>
            </Button>
            <ThemeToggle />
          </div>
        </header>

        <main id="main-content" className="flex-1 px-4 py-6 lg:px-7">
          {children}
        </main>
      </div>
    </div>
  );
}
