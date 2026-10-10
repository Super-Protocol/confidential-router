import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImportReport } from '../../../lib/data-migration';
import { isAdminMock, renderWithSession, sessionMock } from '../../../test-utils';
import { DataMigrationScreen } from './data-migration-screen';

vi.mock('next/navigation', () => ({
  usePathname: () => '/admin/migration',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
}));

vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 5_000 });

const SHA = 'ab12'.repeat(16);

function report(overrides: Partial<ImportReport> = {}): ImportReport {
  return {
    applied: false,
    ok: true,
    schemaVersion: 1,
    exportedAt: '2026-10-10T12:00:00.000Z',
    source: { publicBaseUrl: 'https://old.router.example', routerVersion: '0.17.1', evidenceDigest: 'sha256/abc' },
    contentSha256: SHA,
    counts: { users: 4, inviteCodes: 5, inviteCodesUnredeemed: 2 },
    totalBalanceMicros: '73500000',
    refusals: [],
    sections: [
      { section: 'users', inBundle: 4, toCreate: 3, alreadyPresent: 1, conflicts: [] },
      { section: 'inviteCodes', inBundle: 5, toCreate: 5, alreadyPresent: 0, conflicts: [] },
    ],
    notes: [],
    ...overrides,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  URL.createObjectURL = vi.fn(() => 'blob:export');
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

function renderScreen(admin = true) {
  return renderWithSession(<DataMigrationScreen />, { mocks: [sessionMock(), isAdminMock(admin)] });
}

function exportFile(): File {
  return new File([new Uint8Array([0x1f, 0x8b, 0x08])], 'router-export.json.gz', { type: 'application/gzip' });
}

describe('DataMigrationScreen', () => {
  it('tells a member the section is for administrators, and asks the API nothing', async () => {
    renderScreen(false);

    expect(await screen.findByTestId('data-migration-restricted')).toHaveTextContent('Administrators only');
    expect(screen.queryByTestId('export-button')).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('says what the export leaves behind, API keys included', async () => {
    renderScreen();

    const card = await screen.findByTestId('export-card');
    expect(card).toHaveTextContent('Chats, generation logs and activity history');
    expect(card).toHaveTextContent('everyone issues new keys after a migration');
    expect(card).toHaveTextContent('invitation codes that can still be redeemed');
  });

  it('downloads the export with the session cookie and shows the hash to compare', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: {
          'Content-Disposition': 'attachment; filename="router-export-20261010-1200-old.router.example.json.gz"',
          'X-Export-Sha256': SHA,
        },
      }),
    );
    renderScreen();

    await userEvent.click(await screen.findByTestId('export-button'));

    const done = await screen.findByTestId('export-done');
    expect(done).toHaveTextContent('router-export-20261010-1200-old.router.example.json.gz');
    expect(screen.getByTestId('export-sha')).toHaveTextContent(SHA);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/admin\/data\/export$/);
    expect(init.credentials).toBe('include');
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });

  it('shows the API’s refusal when the export fails', async () => {
    fetchMock.mockResolvedValueOnce(json({ message: 'This operation is restricted to deployment operators.' }, 403));
    renderScreen();

    await userEvent.click(await screen.findByTestId('export-button'));

    expect(await screen.findByTestId('export-error')).toHaveTextContent('restricted to deployment operators');
  });

  it('checks a file first, then imports exactly the file that was checked', async () => {
    fetchMock.mockResolvedValueOnce(json(report())).mockResolvedValueOnce(json(report({ applied: true })));
    renderScreen();

    // Nothing to import until a file has been checked.
    expect(await screen.findByTestId('import-apply')).toBeDisabled();
    expect(screen.getByTestId('import-check')).toBeDisabled();

    await userEvent.upload(screen.getByTestId('import-file'), exportFile());
    expect(screen.getByTestId('import-apply')).toBeDisabled();
    await userEvent.click(screen.getByTestId('import-check'));

    expect(await screen.findByTestId('import-verdict')).toHaveTextContent('Ready to import — nothing written yet');
    expect(screen.getByTestId('import-sha')).toHaveTextContent(SHA);
    expect(screen.getByTestId('import-total-balance')).toHaveTextContent('$73.50');
    const users = within(screen.getByTestId('import-section-users'));
    expect(users.getByText('Accounts')).toBeInTheDocument();
    expect(screen.getByTestId('import-section-users')).toHaveTextContent('Accounts4310');
    const [checkUrl, checkInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(checkUrl).toMatch(/\/admin\/data\/import$/);
    expect(checkInit).toMatchObject({ method: 'POST', credentials: 'include' });
    expect((checkInit.headers as Record<string, string>)['Content-Type']).toBe('application/gzip');

    await userEvent.click(screen.getByTestId('import-apply'));

    await waitFor(() => expect(screen.getByTestId('import-verdict')).toHaveTextContent('Imported'));
    expect(fetchMock.mock.calls[1]?.[0]).toMatch(new RegExp(`/admin/data/import\\?apply=true&expect=${SHA}$`));
    expect(screen.getByTestId('import-next-steps')).toHaveTextContent('each person issues new ones under API Keys');
    // Imported once: the button does not offer to do it again.
    expect(screen.getByTestId('import-apply')).toBeDisabled();
  });

  it('will not import a file the check refused, and says why', async () => {
    fetchMock.mockResolvedValueOnce(
      json(
        report({
          ok: false,
          refusals: [
            'This deployment is not fresh: 2 account(s) exist here that are neither in the export nor an operator’s own.',
          ],
          sections: [
            {
              section: 'inviteCodes',
              inBundle: 5,
              toCreate: 4,
              alreadyPresent: 0,
              conflicts: ['The value of invitation code c-2 is already issued here under another id.'],
            },
          ],
        }),
      ),
    );
    renderScreen();

    await userEvent.upload(await screen.findByTestId('import-file'), exportFile());
    await userEvent.click(screen.getByTestId('import-check'));

    expect(await screen.findByTestId('import-verdict')).toHaveTextContent('Cannot be imported — nothing written');
    expect(screen.getByTestId('import-refusals')).toHaveTextContent('This deployment is not fresh: 2 account(s)');
    expect(screen.getByTestId('import-conflicts')).toHaveTextContent('already issued here under another id');
    expect(screen.getByTestId('import-apply')).toBeDisabled();
  });

  it('shows why a file was not read at all, and forgets a report when another file is chosen', async () => {
    fetchMock
      .mockResolvedValueOnce(json(report()))
      .mockResolvedValueOnce(json({ message: 'The file is not a gzip archive, so it is not a router export.' }, 400));
    renderScreen();

    await userEvent.upload(await screen.findByTestId('import-file'), exportFile());
    await userEvent.click(screen.getByTestId('import-check'));
    expect(await screen.findByTestId('import-report')).toBeInTheDocument();

    await userEvent.upload(screen.getByTestId('import-file'), new File(['x'], 'notes.gz'));
    expect(screen.queryByTestId('import-report')).not.toBeInTheDocument();
    expect(screen.getByTestId('import-apply')).toBeDisabled();

    await userEvent.click(screen.getByTestId('import-check'));
    expect(await screen.findByTestId('import-error')).toHaveTextContent('not a gzip archive');
  });
});
