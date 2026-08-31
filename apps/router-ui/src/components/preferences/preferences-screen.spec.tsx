import type { MockLink } from '@apollo/client/testing';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithSession, TEST_VIEWER, TEST_WORKSPACES } from '../../test-utils';
import { typedSessionMock } from '../typed-session';
import { defaultExportRange, exportRangeInstants } from './export-range';
import { EXPORT_EVIDENCE, PREFERENCES_QUERY, UPDATE_PREFERENCES } from './operations';
import { PreferencesScreen } from './preferences-screen';

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast: toasts }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }), usePathname: () => '/preferences' }));

const WORKSPACE_ID = TEST_WORKSPACES[0].id;

const PREFERENCES = {
  __typename: 'UserPreferences' as const,
  archiveEvidence: true,
  evidenceRetentionDays: 90,
  notifyOnMeasurementChange: true,
  desktopNotifications: false,
  emailReceipts: true,
};

type Preferences = typeof PREFERENCES;

/**
 * A one-user stand-in for the API, rather than a fixed response.
 *
 * The screen's query is `cache-and-network`, so a refetch after a mutation has
 * to answer with what the write left behind — a frozen fixture would hand back
 * the old value and the assertion would be testing the mock, not the screen.
 */
function server(initial: Partial<Preferences> = {}) {
  let stored: Preferences = { ...PREFERENCES, ...initial };

  const query: MockLink.MockedResponse = {
    request: { query: PREFERENCES_QUERY },
    result: () => ({
      data: {
        me: {
          __typename: 'User',
          id: TEST_VIEWER.id,
          email: TEST_VIEWER.email,
          createdAt: '2026-04-02T08:00:00.000Z',
          preferences: stored,
        },
      },
    }),
    maxUsageCount: Number.POSITIVE_INFINITY,
  };

  const update = (input: Record<string, unknown>): MockLink.MockedResponse => ({
    request: { query: UPDATE_PREFERENCES, variables: { input } },
    result: () => {
      stored = { ...stored, ...input };
      return { data: { updatePreferences: stored } };
    },
  });

  return { query, update };
}

beforeEach(() => {
  toasts.success.mockReset();
  toasts.error.mockReset();
});

describe('PreferencesScreen', () => {
  it('shows the account facts and both settings groups', async () => {
    renderWithSession(<PreferencesScreen />, { mocks: [typedSessionMock(), server().query] });

    expect(await screen.findByText(TEST_VIEWER.email)).toBeInTheDocument();
    // The workspace row comes from the session, which resolves independently.
    expect(await screen.findByText(/Default Workspace/)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Archive quotes' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Desktop notifications' })).not.toBeChecked();
  });

  it('says the verification policy lives in the gatekeeper, not here (ADR-002)', async () => {
    renderWithSession(<PreferencesScreen />, { mocks: [typedSessionMock(), server().query] });

    expect(await screen.findByText(/this router never verifies anything/)).toBeInTheDocument();
  });

  it('writes a toggle as soon as it is flipped, sending only that setting', async () => {
    const api = server();
    renderWithSession(<PreferencesScreen />, {
      mocks: [typedSessionMock(), api.query, api.update({ desktopNotifications: true })],
    });

    await userEvent.click(await screen.findByRole('switch', { name: 'Desktop notifications' }));

    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('Desktop notifications on.'));
    // The switch follows the cache, which the mutation's `update` writes — so it
    // stays on after the write rather than snapping back to the cached value.
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Desktop notifications' })).toBeChecked());
  });

  it('reports a rejected write instead of pretending it saved', async () => {
    renderWithSession(<PreferencesScreen />, {
      mocks: [
        typedSessionMock(),
        server().query,
        {
          request: { query: UPDATE_PREFERENCES, variables: { input: { emailReceipts: false } } },
          error: new Error('network down'),
        },
      ],
    });

    await userEvent.click(await screen.findByRole('switch', { name: 'Email receipts' }));

    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('The setting could not be saved.'));
    expect(screen.getByRole('switch', { name: 'Email receipts' })).toBeChecked();
  });

  it('cannot change the retention window while nothing is being archived', async () => {
    renderWithSession(<PreferencesScreen />, {
      mocks: [typedSessionMock(), server({ archiveEvidence: false }).query],
    });

    expect(await screen.findByRole('combobox', { name: 'Retention window' })).toBeDisabled();
  });

  it('offers the stored retention window even when it is not one of the presets', async () => {
    renderWithSession(<PreferencesScreen />, {
      mocks: [typedSessionMock(), server({ evidenceRetentionDays: 45 }).query],
    });

    expect(await screen.findByRole('combobox', { name: 'Retention window' })).toHaveTextContent('45 days');
  });

  it('downloads the evidence bundle from the link the API mints', async () => {
    const range = exportRangeInstants(defaultExportRange()) as { from: string; to: string };
    const click = vi.fn();
    const created = document.createElement('a');
    created.click = click;
    const createElement = vi
      .spyOn(document, 'createElement')
      .mockImplementation((tag: string) =>
        tag === 'a' ? created : document.createElementNS('http://www.w3.org/1999/xhtml', tag),
      );

    renderWithSession(<PreferencesScreen />, {
      mocks: [
        typedSessionMock(),
        server().query,
        {
          request: { query: EXPORT_EVIDENCE, variables: { workspaceId: WORKSPACE_ID, ...range } },
          result: {
            data: {
              exportEvidence: {
                __typename: 'EvidenceExport',
                url: 'https://api.example.com/exports/evidence.zip?token=abc',
                expiresAt: '2026-08-31T10:15:00.000Z',
              },
            },
          },
        },
      ],
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Download' }));

    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(created.href).toBe('https://api.example.com/exports/evidence.zip?token=abc');
    createElement.mockRestore();
  });

  it('refuses a range that ends before it starts, without asking the API', async () => {
    renderWithSession(<PreferencesScreen />, { mocks: [typedSessionMock(), server().query] });

    const from = await screen.findByLabelText('From');
    await userEvent.clear(from);
    await userEvent.type(from, '2026-08-31');
    const to = screen.getByLabelText('To');
    await userEvent.clear(to);
    await userEvent.type(to, '2026-08-01');
    await userEvent.click(screen.getByRole('button', { name: 'Download' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('The end of the range must be on or after its start.');
  });

  it('offers a way back when the settings cannot be read', async () => {
    renderWithSession(<PreferencesScreen />, {
      mocks: [typedSessionMock(), { request: { query: PREFERENCES_QUERY }, error: new Error('network down') }],
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('Your preferences could not be loaded');
  });
});
