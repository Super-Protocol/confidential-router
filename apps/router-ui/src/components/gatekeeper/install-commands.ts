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
   * The line that makes the freshly installed binary runnable in the terminal
   * the reader is already in, or null when the install line has already done it.
   *
   * A `curl | sh` runs in a child process and cannot export into the shell that
   * started it, so on macOS and Linux the PATH entry the installer writes to the
   * startup file only reaches the *next* terminal. Without this line the console
   * printed a block whose first command succeeded and whose second —
   * `gatekeeper init` — was command-not-found (SUP-295).
   *
   * `~/.local/bin` and not some other directory: `tools/installer/install.sh`
   * installs into the first writable candidate already on the PATH and falls
   * back to exactly this one, so the only case where the line is needed is the
   * case where it names the right directory. When the install landed somewhere
   * already searched, prepending this is harmless.
   */
  sessionPath: string | null;
  /**
   * `gatekeeper trust roots add`, written for this shell.
   *
   * It pipes a download into a command, and the two shells do not spell that
   * the same way — so the setup block's test-build section carries a variant per
   * shell rather than a `sh` line a Windows reader has to translate (SUP-193).
   * It is off the default path since SUP-253.
   */
  trustRoot: (name: string, pemUrl: string) => string;
}

export const INSTALL_COMMANDS: InstallCommand[] = [
  {
    id: 'sh',
    platform: 'macOS and Linux',
    shell: 'sh',
    command: `curl -fsSL ${LATEST}/install.sh | sh`,
    sessionPath: 'export PATH="$HOME/.local/bin:$PATH"',
    trustRoot: (name, pemUrl) => `curl -fsSL ${pemUrl} | gatekeeper trust roots add ${name} --pem-file -`,
  },
  {
    id: 'powershell',
    platform: 'Windows',
    shell: 'PowerShell',
    command: `irm ${LATEST}/install.ps1 | iex`,
    // `iex` runs the script in the caller's own session rather than a child
    // process, and install.ps1 updates both the user PATH and `$env:Path` there
    // — so Windows needs no second line.
    sessionPath: null,
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
  'puts the directory it used on your PATH, for the terminals you open next',
];

/** {@link INSTALL_STEPS} as the sentence the install step of the setup block shows. */
export function installStepsSentence(): string {
  return `The script ${INSTALL_STEPS.slice(0, -1).join(', ')} and ${INSTALL_STEPS[INSTALL_STEPS.length - 1]}.`;
}
