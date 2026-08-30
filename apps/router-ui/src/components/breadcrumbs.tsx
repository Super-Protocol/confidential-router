'use client';

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@confidential-router/ui/components/breadcrumb';
import { usePathname } from 'next/navigation';
import { findNavItem } from './navigation';
import { WorkspaceSwitcher } from './workspace-switcher';

/** Falls back to a title-cased segment so a screen added later still gets a crumb. */
function titleFromPathname(pathname: string): string {
  const segment = pathname.split('/').filter(Boolean).at(-1);
  if (!segment) return 'Overview';
  return segment.replace(/-/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

export function AppBreadcrumbs() {
  const pathname = usePathname();
  const title = findNavItem(pathname)?.label ?? titleFromPathname(pathname);

  return (
    <Breadcrumb>
      <BreadcrumbList className="sm:gap-1.5">
        <BreadcrumbItem>
          <WorkspaceSwitcher />
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbPage>{title}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}
