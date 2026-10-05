/**
 * The two one-liners that install the gatekeeper, and the shell each is written
 * for.
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
  /**
   * Stable, URL-safe identifier. It ends up in the tab's generated element ids
   * and in its `aria-controls`, which an axe audit reads as an IDREF — so it
   * cannot be the display name below, whose spaces make that reference invalid.
   */
  id: 'sh' | 'powershell';
  /** Tab label and accessible name of the copy button. */
  platform: string;
  /** The shell the snippet is for, shown above it. */
  shell: string;
  command: string;
  /**
   * `gatekeeper trust roots add`, written for this shell.
   *
   * It is the one step of the setup block that pipes a download into a command,
   * and the two shells do not spell that the same way — so the sequence carries
   * a variant per shell rather than a `sh` line a Windows reader has to
   * translate (SUP-193).
   */
  trustRoot: (name: string, pemUrl: string) => string;
}

export const INSTALL_COMMANDS: InstallCommand[] = [
  {
    id: 'sh',
    platform: 'macOS and Linux',
    shell: 'sh',
    command: `curl -fsSL ${LATEST}/install.sh | sh`,
    trustRoot: (name, pemUrl) => `curl -fsSL ${pemUrl} | gatekeeper trust roots add ${name} --pem-file -`,
  },
  {
    id: 'powershell',
    platform: 'Windows',
    shell: 'PowerShell',
    command: `irm ${LATEST}/install.ps1 | iex`,
    // PowerShell pipes objects, not bytes, so the PEM lands in a file first
    // rather than on the command's standard input.
    trustRoot: (name, pemUrl) =>
      `irm ${pemUrl} -OutFile swarm-root.pem; gatekeeper trust roots add ${name} --pem-file swarm-root.pem`,
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

/** {@link INSTALL_STEPS} as the sentence the install step of the setup block shows. */
export function installStepsSentence(): string {
  return `The script ${INSTALL_STEPS.slice(0, -1).join(', ')} and ${INSTALL_STEPS[INSTALL_STEPS.length - 1]}.`;
}
