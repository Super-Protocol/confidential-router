import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isAdminMock, renderWithApollo } from '../test-utils';
import { NAV_ITEMS, visibleNavGroups } from './navigation';
import { SidebarNav } from './sidebar-nav';

const pathname = vi.hoisted(() => ({ current: '/' }));

vi.mock('next/navigation', () => ({
  usePathname: () => pathname.current,
}));

/**
 * Apollo but no session provider: the nav reads only `ViewerIsAdmin`, which is
 * its own small operation rather than a field on the shell's session query
 * (`use-viewer-is-admin.ts` says why).
 */
function renderNav(ui: React.ReactElement, { admin = true } = {}) {
  return renderWithApollo(ui, { mocks: [isAdminMock(admin)] });
}

const MEMBER_ITEMS = visibleNavGroups(false).flatMap((group) => group.items);

describe('SidebarNav', () => {
  beforeEach(() => {
    pathname.current = '/';
  });

  it('renders every screen as a link inside a labelled navigation landmark', async () => {
    renderNav(<SidebarNav />);
    const nav = screen.getByRole('navigation', { name: 'Console' });

    // The admin entries arrive with the session, so wait for one of them.
    await within(nav).findByRole('link', { name: 'External endpoints' });

    for (const item of NAV_ITEMS) {
      expect(within(nav).getByRole('link', { name: item.label })).toHaveAttribute('href', item.href);
    }
  });

  it('marks the current screen with aria-current, not colour alone', () => {
    pathname.current = '/keys';
    renderNav(<SidebarNav />);

    expect(screen.getByRole('link', { name: 'API Keys' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Overview' })).not.toHaveAttribute('aria-current');
  });

  it('keeps the section marked on a sub-route', () => {
    pathname.current = '/models/llama-3-70b';
    renderNav(<SidebarNav />);

    expect(screen.getByRole('link', { name: 'Models' })).toHaveAttribute('aria-current', 'page');
  });

  it('marks exactly one screen at a time', async () => {
    pathname.current = '/admin/endpoints';
    renderNav(<SidebarNav />);

    await screen.findByRole('link', { name: 'External endpoints' });

    const current = screen.getAllByRole('link').filter((link) => link.getAttribute('aria-current') === 'page');
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveAccessibleName('External endpoints');
  });

  it('closes the mobile drawer when a link is followed', async () => {
    const onNavigate = vi.fn();
    const { default: userEvent } = await import('@testing-library/user-event');
    renderNav(<SidebarNav onNavigate={onNavigate} />);

    await userEvent.click(screen.getByRole('link', { name: 'Activity' }));

    expect(onNavigate).toHaveBeenCalledOnce();
  });

  describe('the Administration group', () => {
    it('is drawn for an administrator', async () => {
      renderNav(<SidebarNav />, { admin: true });

      expect(await screen.findByRole('link', { name: 'External endpoints' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Trust list' })).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'Administration' })).toBeInTheDocument();
    });

    /**
     * Neither the two entries nor the heading over them: a group title with
     * nothing under it would advertise a section a member cannot reach from
     * here, and the whole point of the flag is that the sidebar stays theirs.
     */
    it('is absent for a signed-in member, heading and all', async () => {
      renderNav(<SidebarNav />, { admin: false });

      // The nav renders synchronously; wait for a non-admin entry so the
      // assertion is not made against a tree that has not seen the answer yet.
      await screen.findByRole('link', { name: 'Overview' });

      expect(screen.queryByRole('link', { name: 'External endpoints' })).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Trust list' })).not.toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Administration' })).not.toBeInTheDocument();
      for (const item of MEMBER_ITEMS) {
        expect(screen.getByRole('link', { name: item.label })).toBeInTheDocument();
      }
    });
  });
});
