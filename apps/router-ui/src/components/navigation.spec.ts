import { describe, expect, it } from 'vitest';
import { findNavItem, isNavItemActive, NAV_GROUPS, NAV_ITEMS, visibleNavGroups } from './navigation';

describe('navigation', () => {
  it('covers the twelve console screens', () => {
    expect(NAV_ITEMS.map((item) => item.label)).toEqual([
      'Overview',
      'Models',
      'Chat',
      'API Keys',
      'Gatekeeper',
      'Activity',
      'Logs',
      'External endpoints',
      'Trust list',
      'Credits',
      'Profile',
      'Preferences',
    ]);
  });

  it('groups them as in the prototype, with Administration before Account', () => {
    expect(NAV_GROUPS.map((group) => group.label)).toEqual([
      'Workspace',
      'Access',
      'Insight',
      'Administration',
      'Account',
    ]);
  });

  it('gives every screen a unique route', () => {
    const hrefs = NAV_ITEMS.map((item) => item.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it('matches Overview only on the root path', () => {
    const overview = NAV_ITEMS[0];

    expect(isNavItemActive(overview, '/')).toBe(true);
    expect(isNavItemActive(overview, '/models')).toBe(false);
  });

  it('keeps a section active on its own sub-routes', () => {
    const models = findNavItem('/models');
    if (!models) throw new Error('expected a nav item for /models');

    expect(isNavItemActive(models, '/models')).toBe(true);
    expect(isNavItemActive(models, '/models/llama-3-70b')).toBe(true);
  });

  it('does not treat a same-prefix sibling route as a sub-route', () => {
    const logs = findNavItem('/logs');
    if (!logs) throw new Error('expected a nav item for /logs');

    expect(isNavItemActive(logs, '/logs-export')).toBe(false);
  });

  it('names the admin screens so the breadcrumb does not have to guess', () => {
    expect(findNavItem('/admin/endpoints')?.label).toBe('External endpoints');
    expect(findNavItem('/admin/trust')?.label).toBe('Trust list');
  });

  it('keeps the two admin siblings apart', () => {
    const endpoints = findNavItem('/admin/endpoints');
    if (!endpoints) throw new Error('expected a nav item for /admin/endpoints');

    expect(isNavItemActive(endpoints, '/admin/trust')).toBe(false);
  });
});

describe('visibleNavGroups', () => {
  it('gives an administrator every group', () => {
    expect(visibleNavGroups(true)).toEqual(NAV_GROUPS);
  });

  /**
   * The flag is sidebar hygiene, not access control (the API is) — but a member
   * seeing "Administration" over nothing would be worse than either.
   */
  it('drops the admin-only entries and the group that held them for a member', () => {
    const groups = visibleNavGroups(false);

    expect(groups.map((group) => group.label)).toEqual(['Workspace', 'Access', 'Insight', 'Account']);
    expect(groups.flatMap((group) => group.items).filter((item) => item.adminOnly)).toEqual([]);
  });

  it('marks exactly the two admin screens as admin-only', () => {
    expect(NAV_ITEMS.filter((item) => item.adminOnly).map((item) => item.href)).toEqual([
      '/admin/endpoints',
      '/admin/trust',
    ]);
  });
});
