import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithSession, sessionMock } from '../test-utils';
import { AppShell } from './app-shell';

const pathname = vi.hoisted(() => ({ current: '/' }));
const replace = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  usePathname: () => pathname.current,
  useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }),
}));

describe('AppShell', () => {
  beforeEach(() => {
    pathname.current = '/';
    replace.mockClear();
  });

  it('renders its children inside the main landmark', () => {
    renderWithSession(
      <AppShell>
        <h1>Overview</h1>
      </AppShell>,
    );

    expect(within(screen.getByRole('main')).getByRole('heading', { name: 'Overview' })).toBeInTheDocument();
  });

  it('offers a skip link as the first focusable element', async () => {
    renderWithSession(<AppShell>content</AppShell>);

    await userEvent.tab();

    const skipLink = screen.getByRole('link', { name: 'Skip to content' });
    expect(skipLink).toHaveFocus();
    expect(skipLink).toHaveAttribute('href', '#main-content');
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main-content');
  });

  it('shows the workspace and the screen in the breadcrumb trail', async () => {
    pathname.current = '/models';
    renderWithSession(<AppShell>content</AppShell>);

    const trail = screen.getByRole('navigation', { name: 'breadcrumb' });
    await waitFor(() => {
      expect(within(trail).getByRole('button', { name: /Workspace: Default Workspace/ })).toBeInTheDocument();
    });
    expect(within(trail).getByText('Models')).toBeInTheDocument();
  });

  it('switches the active workspace', async () => {
    renderWithSession(<AppShell>content</AppShell>);

    await waitFor(() => screen.getByRole('button', { name: /Workspace: Default Workspace/ }));
    await userEvent.click(screen.getByRole('button', { name: /Workspace: Default Workspace/ }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Evaluation' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Workspace: Evaluation/ })).toBeInTheDocument();
    });
  });

  it('shows the viewer and their balance once the session resolves', async () => {
    renderWithSession(<AppShell>content</AppShell>);

    expect(await screen.findByRole('button', { name: /Account: Dev Eloper/ })).toBeInTheDocument();
    expect(screen.getByText('$170.65')).toBeInTheDocument();
  });

  it('opens the navigation drawer from the header on small screens', async () => {
    renderWithSession(<AppShell>content</AppShell>);

    await userEvent.click(screen.getByRole('button', { name: 'Open navigation' }));

    // Radix marks the rest of the page `aria-hidden` while the drawer is open,
    // so the drawer's copy of the nav is the only one left in the a11y tree.
    const drawer = await screen.findByRole('dialog', { name: 'Console navigation' });
    expect(within(drawer).getByRole('navigation', { name: 'Console' })).toBeInTheDocument();
    expect(within(drawer).getByRole('link', { name: 'Credits' })).toBeInTheDocument();
  });

  it('sends the viewer to sign-in when the session query comes back unauthenticated', async () => {
    renderWithSession(<AppShell>content</AppShell>, {
      mocks: [
        {
          ...sessionMock(),
          result: { errors: [{ message: 'Authentication is required' }] },
        },
      ],
    });

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/login'));
  });
});
