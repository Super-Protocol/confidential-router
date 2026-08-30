'use client';

import { cn } from '@confidential-router/ui/lib/utils';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { isNavItemActive, NAV_GROUPS } from './navigation';

export interface SidebarNavProps {
  /** Closes the mobile drawer after a navigation. */
  onNavigate?: () => void;
}

/**
 * The grouped console navigation. Rendered twice — once in the fixed desktop
 * sidebar, once inside the mobile drawer — so it owns no chrome of its own.
 */
export function SidebarNav({ onNavigate }: SidebarNavProps) {
  const pathname = usePathname();

  return (
    <nav aria-label="Console" className="flex flex-col gap-4 px-2 py-3">
      {NAV_GROUPS.map((group) => (
        <div key={group.label} className="flex flex-col gap-0.5">
          <h2 className="px-2 pb-1 font-medium text-[0.65rem] text-muted-foreground uppercase tracking-[0.07em]">
            {group.label}
          </h2>
          <ul className="flex flex-col gap-0.5">
            {group.items.map((item) => {
              const active = isNavItemActive(item, pathname);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    // `aria-current` rather than colour alone: the active row is
                    // otherwise only a background tint, which is invisible to a
                    // screen reader and weak for low-vision users.
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm outline-none transition-colors',
                      'focus-visible:ring-[3px] focus-visible:ring-sidebar-ring/60',
                      active
                        ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
                        : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground',
                    )}
                  >
                    <item.icon className="size-4 shrink-0" aria-hidden="true" />
                    <span className="truncate">{item.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
