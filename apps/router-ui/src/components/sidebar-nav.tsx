'use client';

import { cn } from '@confidential-router/ui/lib/utils';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { isNavItemActive, visibleNavGroups } from './navigation';
import { useViewerIsAdmin } from './session/use-viewer-is-admin';

export interface SidebarNavProps {
  /** Closes the mobile drawer after a navigation. */
  onNavigate?: () => void;
}

/**
 * The grouped console navigation. Rendered twice — once in the fixed desktop
 * sidebar, once inside the mobile drawer — so it owns no chrome of its own.
 *
 * The Administration group is drawn only for an administrator. It is gated on
 * `me { isAdmin }` rather than on the viewer's email, because the deployment's
 * `auth.adminEmails` list is configuration the browser is not given — and while
 * the session is still loading the answer is "no", so the entry appears once
 * rather than appearing and then being taken away.
 */
export function SidebarNav({ onNavigate }: SidebarNavProps) {
  const pathname = usePathname();
  const groups = visibleNavGroups(useViewerIsAdmin());

  return (
    <nav aria-label="Console" className="flex flex-col gap-4 px-2 py-3">
      {groups.map((group) => (
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
