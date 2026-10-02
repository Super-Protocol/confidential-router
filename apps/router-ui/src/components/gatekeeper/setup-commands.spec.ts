import { describe, expect, it } from 'vitest';
import { INSTALL_COMMANDS } from './install-commands';
import {
  ENDPOINT_NAME,
  GATEKEEPER_LISTEN,
  type SetupInput,
  setupScript,
  setupSteps,
  TRUST_ROOT_NAME,
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
    expect(setupSteps(input()).map((step) => step.id)).toEqual([
      'install',
      'init',
      'trust-root',
      'endpoint',
      'pin',
      'run',
    ]);
  });

  // The bug SUP-193 was opened for: a page reached from the deployment that *is*
  // the hostname printed `--upstream https://<hostname>` and made the reader
  // edit it. No command this returns, for any input, may carry a placeholder.
  it('renders every command free of angle-bracket placeholders', () => {
    for (const platform of INSTALL_COMMANDS) {
      for (const evidenceDigestHex of [DIGEST, null]) {
        for (const step of setupSteps(input({ platform, evidenceDigestHex }))) {
          expect(step.command).toMatch(/^[^<>]*$/);
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

  it('fetches the trust root from where it is published, not from the endpoint under inspection', () => {
    const trustRoot = setupSteps(input()).find((step) => step.id === 'trust-root');

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
    expect(windows.find((step) => step.id === 'trust-root')?.command).not.toContain('--pem-file -');
    expect(setupSteps(input()).find((step) => step.id === 'trust-root')?.command).toContain('--pem-file -');
  });

  it('leaves the shell-independent commands identical across platforms', () => {
    const shared = (platform: typeof SH) =>
      setupSteps(input({ platform }))
        .filter((step) => step.id !== 'install' && step.id !== 'trust-root')
        .map((step) => step.command);

    expect(shared(POWERSHELL)).toEqual(shared(SH));
  });
});

describe('setupScript', () => {
  it('is the whole sequence, one command per line, ready to paste', () => {
    const steps = setupSteps(input());

    expect(setupScript(input())).toBe(steps.map((step) => step.command).join('\n'));
    expect(setupScript(input()).split('\n')).toHaveLength(steps.length);
  });
});
