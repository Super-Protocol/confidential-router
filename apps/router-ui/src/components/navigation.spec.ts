import { describe, expect, it } from 'vitest';
import { findNavItem, isNavItemActive, NAV_GROUPS, NAV_ITEMS } from './navigation';

describe('navigation', () => {
  it('covers the nine console screens', () => {
    expect(NAV_ITEMS.map((item) => item.label)).toEqual([
      'Overview',
      'Models',
      'API Keys',
      'Gatekeeper',
      'Activity',
      'Logs',
      'Credits',
      'Profile',
      'Preferences',
    ]);
  });

  it('groups them as in the prototype', () => {
    expect(NAV_GROUPS.map((group) => group.label)).toEqual(['Workspace', 'Access', 'Insight', 'Account']);
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
});
