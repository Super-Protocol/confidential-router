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

  /*
   * SUP-295 item 1. A `curl | sh` installs into a child process's idea of the
   * world: it can write the reader's startup file, and it cannot touch the PATH
   * of the terminal they are standing in. The console block is copied as a
   * whole, so the line that closes that gap has to be in the block.
   */
  it('carries the line that makes the binary runnable in the current terminal', () => {
    expect(INSTALL_COMMANDS[0].sessionPath).toBe('export PATH="$HOME/.local/bin:$PATH"');
  });

  it('leaves Windows without one, because `iex` already ran in this session', () => {
    expect(INSTALL_COMMANDS[1].sessionPath).toBeNull();
  });

  it('names the directory the installer falls back to', () => {
    // The other half of this contract — that `tools/installer/install.sh` really
    // does fall back to `$HOME/.local/bin` — is checked by `install.test.sh`,
    // which can read both files. A PATH line for any other directory would be a
    // line that fixes nothing.
    expect(INSTALL_COMMANDS[0].sessionPath).toContain('$HOME/.local/bin');
  });
});

describe('INSTALL_STEPS', () => {
  it('says the download is verified — the reason the one-liner is offered at all', () => {
    expect(INSTALL_STEPS.some((step) => step.includes('verifies it against the release checksums'))).toBe(true);
  });

  it('says the installer puts its directory on the PATH, which it now does', () => {
    expect(INSTALL_STEPS.some((step) => step.includes('on your PATH'))).toBe(true);
  });
});
