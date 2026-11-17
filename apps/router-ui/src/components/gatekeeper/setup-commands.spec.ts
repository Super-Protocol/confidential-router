import { describe, expect, it } from 'vitest';
import { INSTALL_COMMANDS } from './install-commands';
import {
  ENDPOINT_NAME,
  GATEKEEPER_LISTEN,
  type SetupInput,
  setupScript,
  setupSteps,
  TRUST_ROOT_NAME,
  testBuildSteps,
} from './setup-commands';

const [SH, POWERSHELL] = INSTALL_COMMANDS;

const DIGEST = 'ab'.repeat(32);

function input(overrides: Partial<SetupInput> = {}): SetupInput {
  return {
    upstream: 'https://api.router.example.com',
    swarmRootPemUrl: 'https://router.example.com/swarm-root.pem',
    platform: SH,
    ...overrides,
  };
}

describe('setupSteps', () => {
  it('is the sequence the landing page ships, install first (SUP-155 parity)', () => {
    expect(setupSteps(input()).map((step) => step.id)).toEqual(['install', 'init', 'endpoint', 'pin', 'run']);
  });

  // SUP-253: the registry of signed measurements is the default anchor, so no
  // step of the default path trusts a certificate.
  it('has no trust-root step and never touches the published root certificate', () => {
    for (const platform of INSTALL_COMMANDS) {
      for (const step of setupSteps(input({ platform }))) {
        expect(step.command).not.toContain('trust roots add');
        expect(step.command).not.toContain('swarm-root.pem');
      }
    }
  });

  // The bug SUP-193 was opened for: a page reached from the deployment that *is*
  // the hostname printed `--upstream https://<hostname>` and made the reader
  // edit it. No command this returns, for any input, may carry a placeholder.
  it('renders every command free of angle-bracket placeholders', () => {
    for (const platform of INSTALL_COMMANDS) {
      for (const evidenceDigestHex of [DIGEST, null]) {
        for (const step of [
          ...setupSteps(input({ platform, evidenceDigestHex })),
          ...testBuildSteps(input({ platform, evidenceDigestHex })),
        ]) {
          expect(step.command).toMatch(/^[^<>]*$/);
        }
      }
    }
  });

  /*
   * SUP-295 item 1: the block is copied whole and run top to bottom, so every
   * command after the install has to be reachable. On a stock macOS zsh the
   * binary lands in ~/.local/bin, which that shell does not search — and the
   * second step was command-not-found for every reader on that platform.
   */
  it('puts the install directory on this terminal’s PATH before the next command runs', () => {
    const [install, next] = setupSteps(input());

    expect(install.command).toBe(`${SH.command}\nexport PATH="$HOME/.local/bin:$PATH"`);
    expect(next.command).toBe('gatekeeper init');
  });

  it('spares Windows a PATH line it does not need', () => {
    const install = setupSteps(input({ platform: POWERSHELL })).find((step) => step.id === 'install');

    expect(install?.command).toBe(POWERSHELL.command);
    expect(install?.command).not.toContain('PATH');
  });

  /*
   * SUP-300 item 2: step 2 promised `~/.config/confidential-gatekeeper/config.yaml`,
   * which is not where the file lands on macOS (`~/Library/Application Support`)
   * or Windows (`%AppData%`) — `config.DefaultPath()` is Go's
   * `os.UserConfigDir()`. A tester on macOS was told a path that never existed.
   *
   * The rule the two surfaces split between them: copy written *before* a
   * command runs never names a path, and the CLI prints the one it resolved
   * afterwards. This holds the browser half of it; the terminal half is
   * `TestNoCommandInventsAConfigurationPath` in `apps/gatekeeper/pkg/cli`.
   */
  it('never promises a filesystem path it cannot know', () => {
    const invented = [/~\//, /\$HOME/, /Library\/Application Support/, /AppData/, /\/Users\//, /C:\\/];

    for (const platform of INSTALL_COMMANDS) {
      for (const evidenceDigestHex of [DIGEST, null]) {
        const steps = [
          ...setupSteps(input({ platform, evidenceDigestHex })),
          ...testBuildSteps(input({ platform, evidenceDigestHex })),
        ];
        for (const step of steps) {
          for (const pattern of invented) {
            // The install command is the one place a home-relative path is not
            // a promise: `export PATH="$HOME/.local/bin:$PATH"` is a line the
            // reader's own shell expands, and it is what SUP-295 added.
            if (step.id === 'install') continue;
            expect(`${step.title} ${step.detail}`, `${step.id} detail`).not.toMatch(pattern);
            expect(step.command, `${step.id} command`).not.toMatch(pattern);
          }
        }
      }
    }
  });

  it('fronts the origin it was given, on loopback — a gatekeeper on 0.0.0.0 is an open relay', () => {
    const endpoint = setupSteps(input()).find((step) => step.id === 'endpoint');

    expect(endpoint?.command).toBe(
      `gatekeeper endpoint add ${ENDPOINT_NAME} --upstream https://api.router.example.com --listen ${GATEKEEPER_LISTEN}`,
    );
    expect(GATEKEEPER_LISTEN.startsWith('127.0.0.1:')).toBe(true);
  });

  it('fetches the test-build trust root from where it is published, not from the endpoint under inspection', () => {
    const trustRoot = testBuildSteps(input()).find((step) => step.id === 'trust-root');

    expect(trustRoot?.command).toContain('https://router.example.com/swarm-root.pem');
    expect(trustRoot?.command).toContain(`gatekeeper trust roots add ${TRUST_ROOT_NAME}`);
    expect(trustRoot?.command).not.toContain('api.router.example.com');
  });

  it('pins the digest it was handed, against the endpoint name it just added', () => {
    const steps = setupSteps(input({ evidenceDigestHex: DIGEST }));

    expect(steps.find((step) => step.id === 'pin')?.command).toBe(
      `gatekeeper endpoint trust add ${ENDPOINT_NAME} sha256:${DIGEST}`,
    );
  });

  // Never `sha256:<evidenceDigest>`: a pin the reader has to go and find is the
  // one line of the sequence that silently does not run.
  it('takes the published digest when it has none, rather than leaving a pin to fill in', () => {
    const pin = setupSteps(input({ evidenceDigestHex: null })).find((step) => step.id === 'pin');

    expect(pin?.command).toBe(`gatekeeper endpoint trust add ${ENDPOINT_NAME} --from-upstream`);
    expect(pin?.detail).toContain('not trust-on-first-use');
  });

  it('writes the two piped lines for the chosen shell', () => {
    const windows = setupSteps(input({ platform: POWERSHELL }));

    expect(windows.find((step) => step.id === 'install')?.command).toBe(POWERSHELL.command);
    // PowerShell pipes objects, so the PEM goes to a file rather than stdin.
    const rootFor = (platform: typeof SH) =>
      testBuildSteps(input({ platform })).find((step) => step.id === 'trust-root')?.command;
    expect(rootFor(POWERSHELL)).not.toContain('--pem-file -');
    expect(rootFor(SH)).toContain('--pem-file -');
  });

  it('leaves the shell-independent commands identical across platforms', () => {
    const shared = (platform: typeof SH) =>
      setupSteps(input({ platform }))
        .filter((step) => step.id !== 'install')
        .map((step) => step.command);

    expect(shared(POWERSHELL)).toEqual(shared(SH));
  });
});

describe('testBuildSteps', () => {
  it('offers the measurement pin first, the root certificate second', () => {
    expect(testBuildSteps(input()).map((step) => step.id)).toEqual(['trust-measurement', 'trust-root']);
    expect(testBuildSteps(input())[0].command).toBe(
      `gatekeeper trust measurements add --from-upstream ${ENDPOINT_NAME}`,
    );
  });
});

describe('setupScript', () => {
  it('is the whole sequence, every line a command, ready to paste', () => {
    const steps = setupSteps(input());
    const lines = setupScript(input()).split('\n');

    expect(setupScript(input())).toBe(steps.map((step) => step.command).join('\n'));
    // One line per step, plus the PATH line the install step carries on this
    // platform — and no blank or continuation line anywhere, which is what
    // makes the block safe to paste as a whole.
    expect(lines).toHaveLength(steps.length + 1);
    for (const line of lines) {
      expect(line.trim()).toBe(line);
      expect(line).not.toBe('');
    }
  });

  it('leaves the test-build commands out of the script', () => {
    for (const step of testBuildSteps(input())) {
      expect(setupScript(input())).not.toContain(step.command);
    }
  });
});
