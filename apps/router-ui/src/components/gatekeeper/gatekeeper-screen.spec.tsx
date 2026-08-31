import type { MockLink } from '@apollo/client/testing';
import { MockedProvider } from '@apollo/client/testing/react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GatekeeperScreen } from './gatekeeper-screen';
import { INSTALL_COMMANDS } from './install-commands';
import { GATEKEEPER_RELEASE_QUERY } from './operations';
import { SETUP_STEPS, setupScript } from './setup-commands';

const RELEASE = {
  __typename: 'GatekeeperRelease',
  version: 'v0.4.1',
  notesUrl: 'https://github.com/Super-Protocol/confidential-router/releases/tag/v0.4.1',
  checksumsUrl: 'https://github.com/Super-Protocol/confidential-router/releases/download/v0.4.1/checksums.txt',
  publishedAt: '2026-08-20T10:00:00.000Z',
  fetchedAt: '2026-08-31T09:00:00.000Z',
  stale: false,
  downloads: [
    {
      __typename: 'GatekeeperDownload',
      os: 'LINUX',
      arch: 'AMD64',
      name: 'gatekeeper_0.4.1_linux_amd64.tar.gz',
      url: 'https://example.invalid/gatekeeper_0.4.1_linux_amd64.tar.gz',
      sizeBytes: 14_800_000,
    },
    {
      __typename: 'GatekeeperDownload',
      os: 'MACOS',
      arch: 'ARM64',
      name: 'gatekeeper_0.4.1_darwin_arm64.zip',
      url: 'https://example.invalid/gatekeeper_0.4.1_darwin_arm64.zip',
      sizeBytes: 0,
    },
  ],
};

function releaseMock(release: unknown = RELEASE): MockLink.MockedResponse {
  return {
    request: { query: GATEKEEPER_RELEASE_QUERY },
    result: { data: { gatekeeperRelease: release } },
    maxUsageCount: Number.POSITIVE_INFINITY,
  };
}

function renderScreen(mocks: MockLink.MockedResponse[] = [releaseMock()]) {
  return render(
    <MockedProvider mocks={mocks}>
      <GatekeeperScreen />
    </MockedProvider>,
  );
}

beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
});

describe('GatekeeperScreen', () => {
  it('links every published build, its checksums and its notes', async () => {
    renderScreen();

    const linux = (await screen.findByText('gatekeeper_0.4.1_linux_amd64.tar.gz')).closest('tr') as HTMLElement;
    expect(within(linux).getByText('Linux')).toBeInTheDocument();
    expect(within(linux).getByText('x86-64 (amd64)')).toBeInTheDocument();
    expect(within(linux).getByText('14.8 MB')).toBeInTheDocument();
    expect(within(linux).getByRole('link', { name: /Download/ })).toHaveAttribute(
      'href',
      'https://example.invalid/gatekeeper_0.4.1_linux_amd64.tar.gz',
    );

    expect(screen.getByText('v0.4.1')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Checksums/ })).toHaveAttribute('href', RELEASE.checksumsUrl);
    expect(screen.getByRole('link', { name: /Release notes/ })).toHaveAttribute('href', RELEASE.notesUrl);
  });

  it('renders an unknown asset size as a dash rather than zero bytes', async () => {
    renderScreen();

    const macos = (await screen.findByText('gatekeeper_0.4.1_darwin_arm64.zip')).closest('tr') as HTMLElement;
    expect(within(macos).getByText('—')).toBeInTheDocument();
  });

  it('says when the links are the last known ones', async () => {
    renderScreen([releaseMock({ ...RELEASE, stale: true })]);

    expect(await screen.findByText('Last known links')).toBeInTheDocument();
  });

  it('still explains the setup when no build has been published', async () => {
    renderScreen([releaseMock(null)]);

    expect(await screen.findByText('No published build yet')).toBeInTheDocument();
    expect(screen.getByText(SETUP_STEPS[0].command)).toBeInTheDocument();
  });

  it('reports a failed release lookup without hiding the rest of the page', async () => {
    renderScreen([{ request: { query: GATEKEEPER_RELEASE_QUERY }, error: new Error('github unreachable') }]);

    expect(await screen.findByText('The release could not be loaded')).toBeInTheDocument();
    expect(screen.getByText(SETUP_STEPS[3].command)).toBeInTheDocument();
  });

  it('offers a verified one-liner per platform, and says what it does before you paste it', async () => {
    renderScreen();

    for (const entry of INSTALL_COMMANDS) {
      expect(screen.getByText(entry.command)).toBeInTheDocument();
    }

    await userEvent.click(
      screen.getByRole('button', { name: `Copy the ${INSTALL_COMMANDS[0].platform} install command` }),
    );
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(INSTALL_COMMANDS[0].command);
    expect(screen.getByText(/verifies it against the release checksums/)).toBeInTheDocument();
  });

  it('still offers the one-liners when the release lookup failed — the scripts ship with every release', async () => {
    renderScreen([{ request: { query: GATEKEEPER_RELEASE_QUERY }, error: new Error('github unreachable') }]);

    expect(await screen.findByText('The release could not be loaded')).toBeInTheDocument();
    for (const entry of INSTALL_COMMANDS) {
      expect(screen.getByText(entry.command)).toBeInTheDocument();
    }
  });

  it('lists the four setup commands in order, and copies them as a script', async () => {
    renderScreen();

    for (const step of SETUP_STEPS) {
      expect(screen.getByText(step.command)).toBeInTheDocument();
    }

    await userEvent.click(screen.getByRole('button', { name: 'Copy all four commands' }));

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(setupScript());
  });

  it('shows the data flow, the four checks and both fail modes — the page is an explainer, not a control panel', () => {
    renderScreen();

    expect(screen.getByRole('heading', { level: 1, name: 'Gatekeeper' })).toBeInTheDocument();
    expect(screen.getByText('Your agents')).toBeInTheDocument();
    expect(screen.getByText('Confidential endpoint')).toBeInTheDocument();
    expect(screen.getByText('Bind it to the connection')).toBeInTheDocument();
    expect(screen.getByText('Fail closed')).toBeInTheDocument();
    expect(screen.getByText('Fail open')).toBeInTheDocument();
    // ADR-002: nothing here registers a gatekeeper or reports a verdict.
    expect(screen.queryByRole('button', { name: /register/i })).not.toBeInTheDocument();
  });

  it('names Desktop and Docker as not built yet rather than leaving them out', async () => {
    renderScreen();

    expect(await screen.findByText('Gatekeeper Desktop')).toBeInTheDocument();
    expect(screen.getByText('Docker image')).toBeInTheDocument();
    expect(screen.getAllByText('Coming later')).toHaveLength(2);
  });
});
