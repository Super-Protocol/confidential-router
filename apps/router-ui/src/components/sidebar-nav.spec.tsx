import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NAV_ITEMS } from './navigation';
import { SidebarNav } from './sidebar-nav';

const pathname = vi.hoisted(() => ({ current: '/' }));

vi.mock('next/navigation', () => ({
  usePathname: () => pathname.current,
}));

describe('SidebarNav', () => {
  beforeEach(() => {
    pathname.current = '/';
  });

  it('renders every screen as a link inside a labelled navigation landmark', () => {
    render(<SidebarNav />);
    const nav = screen.getByRole('navigation', { name: 'Console' });

    for (const item of NAV_ITEMS) {
      expect(within(nav).getByRole('link', { name: item.label })).toHaveAttribute('href', item.href);
    }
  });

  it('marks the current screen with aria-current, not colour alone', () => {
    pathname.current = '/keys';
    render(<SidebarNav />);

    expect(screen.getByRole('link', { name: 'API Keys' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Overview' })).not.toHaveAttribute('aria-current');
  });

  it('keeps the section marked on a sub-route', () => {
    pathname.current = '/models/llama-3-70b';
    render(<SidebarNav />);

    expect(screen.getByRole('link', { name: 'Models' })).toHaveAttribute('aria-current', 'page');
  });

  it('marks exactly one screen at a time', () => {
    pathname.current = '/logs';
    render(<SidebarNav />);

    const current = screen.getAllByRole('link').filter((link) => link.getAttribute('aria-current') === 'page');
    expect(current).toHaveLength(1);
  });

  it('closes the mobile drawer when a link is followed', async () => {
    const onNavigate = vi.fn();
    const { default: userEvent } = await import('@testing-library/user-event');
    render(<SidebarNav onNavigate={onNavigate} />);

    await userEvent.click(screen.getByRole('link', { name: 'Activity' }));

    expect(onNavigate).toHaveBeenCalledOnce();
  });
});
