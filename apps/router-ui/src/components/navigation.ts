import {
  Activity,
  BookText,
  CreditCard,
  Globe,
  KeyRound,
  LayoutDashboard,
  type LucideIcon,
  MessagesSquare,
  ScrollText,
  ShieldCheck,
  SlidersHorizontal,
  UserRound,
} from 'lucide-react';

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  /** One line of "what is this screen for", used by placeholder pages. */
  summary: string;
  /**
   * Drawn only for a viewer `me { isAdmin }` reports as an administrator.
   *
   * The screens themselves read for any signed-in member on purpose (ADR-008 §7,
   * ruling 3) — this flag keeps them out of everyone's sidebar, it is not the
   * access control. The API is, and it scopes the credential fields away.
   */
  adminOnly?: boolean;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

/**
 * The console screens, grouped as in the prototype. This is the single
 * source of truth for the sidebar, the breadcrumb trail and the page titles —
 * three places that drifted apart in swarm-cloud because each kept its own list.
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Workspace',
    items: [
      {
        label: 'Overview',
        href: '/',
        icon: LayoutDashboard,
        summary: 'Spend, requests, tokens and evidence coverage for the current period.',
      },
      {
        label: 'Models',
        href: '/models',
        icon: BookText,
        summary: 'Every model this router serves, its endpoint, context window and price.',
      },
      {
        label: 'Chat',
        href: '/chat',
        icon: MessagesSquare,
        summary: 'Talk to a served model, with the endpoint verified in this browser first.',
      },
    ],
  },
  {
    label: 'Access',
    items: [
      {
        label: 'API Keys',
        href: '/keys',
        icon: KeyRound,
        summary: 'Issue, scope and revoke keys, and copy the drop-in base-URL snippet.',
      },
      {
        label: 'Gatekeeper',
        href: '/gatekeeper',
        icon: ShieldCheck,
        summary: 'Download the verifying proxy and pin the evidence digests you trust.',
      },
    ],
  },
  {
    label: 'Insight',
    items: [
      {
        label: 'Activity',
        href: '/activity',
        icon: Activity,
        summary: 'Spend and usage over time, by model and by key.',
      },
      {
        label: 'Logs',
        href: '/logs',
        icon: ScrollText,
        summary: 'Per-generation metering: tokens, cost, latency and the evidence in force.',
      },
    ],
  },
  {
    label: 'Administration',
    items: [
      {
        label: 'External endpoints',
        href: '/admin/endpoints',
        icon: Globe,
        summary: 'Models served by other deployments, and what this router\u2019s own verification says about each.',
        adminOnly: true,
      },
      {
        label: 'Trust list',
        href: '/admin/trust',
        icon: ShieldCheck,
        summary: 'The launch measurements this deployment accepts for an external upstream.',
        adminOnly: true,
      },
    ],
  },
  {
    label: 'Account',
    items: [
      {
        label: 'Credits',
        href: '/credits',
        icon: CreditCard,
        summary: 'Balance, transactions, top-ups and auto top-up.',
      },
      {
        label: 'Profile',
        href: '/profile',
        icon: UserRound,
        summary: 'Your account, and the days your responses came with signed evidence.',
      },
      {
        label: 'Preferences',
        href: '/preferences',
        icon: SlidersHorizontal,
        summary: 'Evidence archiving and retention, notifications and receipts.',
      },
    ],
  },
];

export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((group) => group.items);

/**
 * The groups one viewer may see, with empty groups dropped — so a non-admin gets
 * no "Administration" heading over nothing.
 */
export function visibleNavGroups(isAdmin: boolean): NavGroup[] {
  if (isAdmin) return NAV_GROUPS;
  return NAV_GROUPS.map((group) => ({ ...group, items: group.items.filter((item) => !item.adminOnly) })).filter(
    (group) => group.items.length > 0,
  );
}

export function findNavItem(pathname: string): NavItem | undefined {
  return NAV_ITEMS.find((item) => item.href === pathname);
}

/**
 * Marks the sidebar entry for the section a URL belongs to. `/` is matched
 * exactly — otherwise Overview would light up on every page, since every path
 * starts with a slash.
 */
export function isNavItemActive(item: NavItem, pathname: string): boolean {
  return item.href === '/' ? pathname === '/' : pathname === item.href || pathname.startsWith(`${item.href}/`);
}
