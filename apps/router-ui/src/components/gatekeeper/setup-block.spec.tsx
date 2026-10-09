import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PUBLIC_CONFIG_GLOBAL, type PublicConfig } from '../../lib/public-config';
import { verificationState } from '../../test-fixtures';
import { VerificationPanel } from '../chat/verification-panel';
import { HowToConnect } from '../keys/how-to-connect';
import { INSTALL_COMMANDS } from './install-commands';
import { setupScript } from './setup-commands';

/**
 * The deployment both surfaces are rendered against. `api.example.test` is the
 * API origin *and* the endpoint hostname, which is the only arrangement either
 * screen can speak for: the console and the endpoint are one deployment.
 */
const CONFIG: PublicConfig = {
  apiOrigin: 'https://api.example.test',
  graphqlHttp: 'https://api.example.test/graphql',
  authCallbackUrl: '/',
  swarmRootPemUrl: 'https://landing.example.test/swarm-root.pem',
};

const injected = globalThis as unknown as Record<string, unknown>;

/** Every command of the numbered sequence, in order, wherever the block is mounted. */
function renderedCommands(): string[] {
  const block = document.querySelector('[data-testid="gatekeeper-setup"]');
  expect(block).not.toBeNull();
  return [...(block?.querySelectorAll('ol pre code') ?? [])].map((node) => node.textContent ?? '');
}

/** The commands of the collapsed test-build section. */
function testBuildCommands(): string[] {
  const section = document.querySelector('[data-testid="gatekeeper-setup-test-builds"]');
  expect(section).not.toBeNull();
  return [...(section?.querySelectorAll('pre code') ?? [])].map((node) => node.textContent ?? '');
}

beforeEach(() => {
  injected[PUBLIC_CONFIG_GLOBAL] = CONFIG;
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
});

afterEach(() => {
  delete injected[PUBLIC_CONFIG_GLOBAL];
});

describe('GatekeeperSetupBlock', () => {
  it('renders every command with this deployment’s own values and no placeholder', () => {
    render(<HowToConnect />);

    const commands = renderedCommands();

    expect(commands).toHaveLength(5);
    for (const command of [...commands, ...testBuildCommands()]) {
      expect(command).toMatch(/^[^<>]*$/);
    }
    expect(commands.some((command) => command.includes(`--upstream ${CONFIG.apiOrigin}`))).toBe(true);
  });

  // SUP-253: a cloud built by the release flow is admitted on its signed
  // measurement, so the default path has nothing to paste about trust. The
  // root certificate is still one click away, for a build the registry never
  // signed — and it is not in the copy-all script.
  it('keeps the root certificate out of the default sequence and in the collapsed test-build section', () => {
    render(<HowToConnect />);

    const commands = renderedCommands();
    expect(commands.some((command) => command.includes('trust roots add'))).toBe(false);
    expect(commands.some((command) => command.includes(CONFIG.swarmRootPemUrl))).toBe(false);

    const section = screen.getByTestId('gatekeeper-setup-test-builds');
    expect(section.tagName).toBe('DETAILS');
    expect((section as HTMLDetailsElement).open).toBe(false);
    expect(section).toHaveTextContent('Optional: test or unsigned builds');
    expect(section).toHaveTextContent('not signed in the Super Protocol registry');
    expect(section).toHaveTextContent('without a restart');

    const optional = testBuildCommands();
    expect(optional).toEqual([
      'gatekeeper trust measurements add --from-upstream router',
      `curl -fsSL ${CONFIG.swarmRootPemUrl} | gatekeeper trust roots add swarm-prod --pem-file -`,
    ]);
  });

  // SUP-153/165 were catalogue copies drifting apart; this is the same failure
  // waiting to happen to the commands, so the block is shared and the two
  // surfaces are asserted against each other rather than against a literal.
  it('gives the chat panel and the API Keys page the same sequence for the same deployment', () => {
    const page = render(<HowToConnect />);
    const fromPage = renderedCommands();
    page.unmount();

    const panel = render(
      <VerificationPanel
        open
        onOpenChange={() => undefined}
        verification={verificationState()}
        hostname="api.example.test"
        evidenceDigestHex={null}
      />,
    );
    const fromPanel = renderedCommands();
    panel.unmount();

    expect(fromPanel).toEqual(fromPage);
  });

  it('pins the digest the chat already verified, where the page takes the published one', () => {
    const digest = 'ab'.repeat(32);
    render(
      <VerificationPanel
        open
        onOpenChange={() => undefined}
        verification={verificationState()}
        hostname="api.example.test"
        evidenceDigestHex={digest}
      />,
    );

    expect(renderedCommands()).toContain(`gatekeeper endpoint trust add router sha256:${digest}`);
  });

  it('copies the whole sequence as one script for the shell the reader picked', async () => {
    render(<HowToConnect />);

    // Held by reference: the button renames itself to "Copied" for two seconds
    // after a copy, and the second press is the same control.
    const copyAll = screen.getByRole('button', { name: 'Copy the whole sequence' });

    await userEvent.click(copyAll);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      setupScript({
        upstream: CONFIG.apiOrigin,
        swarmRootPemUrl: CONFIG.swarmRootPemUrl,
        platform: INSTALL_COMMANDS[0],
        evidenceDigestHex: null,
      }),
    );

    await userEvent.click(screen.getByRole('tab', { name: INSTALL_COMMANDS[1].platform }));

    expect(renderedCommands()).toContain(INSTALL_COMMANDS[1].command);
    await userEvent.click(copyAll);
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(
      setupScript({
        upstream: CONFIG.apiOrigin,
        swarmRootPemUrl: CONFIG.swarmRootPemUrl,
        platform: INSTALL_COMMANDS[1],
        evidenceDigestHex: null,
      }),
    );
  });
});
