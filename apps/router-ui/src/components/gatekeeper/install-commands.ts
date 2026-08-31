/**
 * The two one-liners that install the gatekeeper.
 *
 * They fetch the scripts published with every release
 * (`tools/installer/install.sh` and `install.ps1`, attached by
 * `.github/workflows/release-gatekeeper.yml`), which is why the URL is
 * `releases/latest/download/...` and not a path in the default branch: a user
 * gets the installer that was written for the release it is about to install.
 *
 * `latest` never resolves to a pre-release, so neither the nightly nor a
 * release candidate can be installed by accident.
 */

/** Where the gatekeeper is released. Also the repository the console lives in. */
export const GATEKEEPER_REPO = 'Super-Protocol/confidential-router';

const LATEST = `https://github.com/${GATEKEEPER_REPO}/releases/latest/download`;

export interface InstallCommand {
  /** Tab label and accessible name of the copy button. */
  platform: string;
  /** The shell the snippet is for, shown above it. */
  shell: string;
  command: string;
}

export const INSTALL_COMMANDS: InstallCommand[] = [
  {
    platform: 'macOS and Linux',
    shell: 'sh',
    command: `curl -fsSL ${LATEST}/install.sh | sh`,
  },
  {
    platform: 'Windows',
    shell: 'PowerShell',
    command: `irm ${LATEST}/install.ps1 | iex`,
  },
];

/**
 * What the scripts do, in the order they do it. Rendered next to the commands:
 * anyone pasting a `curl | sh` is entitled to know what it will do first.
 */
export const INSTALL_STEPS = [
  'detects your OS and CPU',
  'downloads the matching archive from the latest release',
  'verifies it against the release checksums',
  'installs one binary, and nothing else',
];
