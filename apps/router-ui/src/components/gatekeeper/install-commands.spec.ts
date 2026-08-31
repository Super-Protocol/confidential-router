import { describe, expect, it } from 'vitest';
import { GATEKEEPER_REPO, INSTALL_COMMANDS, INSTALL_STEPS } from './install-commands';

describe('INSTALL_COMMANDS', () => {
  it('covers the two shells the release publishes an installer for', () => {
    expect(INSTALL_COMMANDS.map((entry) => entry.shell)).toEqual(['sh', 'PowerShell']);
  });

  it('fetches the script published with the release, not one from a branch', () => {
    for (const entry of INSTALL_COMMANDS) {
      expect(entry.command).toContain(`https://github.com/${GATEKEEPER_REPO}/releases/latest/download/`);
      expect(entry.command).not.toContain('raw.githubusercontent.com');
    }
  });

  it('names the scripts the release workflow actually attaches', () => {
    expect(INSTALL_COMMANDS[0].command).toContain('/install.sh');
    expect(INSTALL_COMMANDS[1].command).toContain('/install.ps1');
  });

  it('fails the download rather than piping a 404 into a shell', () => {
    // `curl -f` exits non-zero on an error response instead of writing the
    // error page to stdout, which `| sh` would otherwise execute.
    expect(INSTALL_COMMANDS[0].command).toMatch(/^curl -[a-zA-Z]*f[a-zA-Z]* /);
  });
});

describe('INSTALL_STEPS', () => {
  it('says the download is verified — the reason the one-liner is offered at all', () => {
    expect(INSTALL_STEPS.some((step) => step.includes('verifies it against the release checksums'))).toBe(true);
  });
});
