/**
 * The four commands that take a fresh download to a verifying proxy.
 *
 * Kept as data rather than markup so the page and its test agree on the exact
 * text — a command a user pastes is part of the product's contract with the
 * gatekeeper CLI (`apps/gatekeeper/pkg/cli`).
 */

/** The listen address the console suggests everywhere, including the snippet. */
export const GATEKEEPER_LISTEN = '127.0.0.1:8787';

/** The endpoint name used throughout the docs; any name works. */
export const ENDPOINT_NAME = 'router';

export interface SetupStep {
  command: string;
  title: string;
  detail: string;
}

export const SETUP_STEPS: SetupStep[] = [
  {
    command: 'gatekeeper init',
    title: 'Write a starter config',
    detail:
      'Creates ~/.config/confidential-gatekeeper/config.yaml with the default policy. No root to paste: a Swarm cloud\u2019s certificate authority is accepted on its own TEE evidence. Nothing is contacted.',
  },
  {
    command: `gatekeeper endpoint add ${ENDPOINT_NAME} --upstream https://<hostname> --listen ${GATEKEEPER_LISTEN}`,
    title: 'Front an endpoint',
    detail:
      'The hostname is the router endpoint you want to reach; the listen address is what your agents will point at. Take the hostname from Models, where each model names the endpoint that serves it.',
  },
  {
    command: `gatekeeper endpoint trust add ${ENDPOINT_NAME} sha256:<evidenceDigest>`,
    title: 'Pin what you are willing to trust',
    detail:
      'Copy the evidenceDigest from Overview — the same sha256:<hex> string the gatekeeper prints back. Only a bundle whose digest you pinned here passes: the router cannot add one, and a digest that changes is a deployment you have not approved.',
  },
  {
    command: 'gatekeeper run',
    title: 'Run it',
    detail:
      'Verifies before it forwards, re-attests on its own schedule, and refuses the request if any check fails. Point your OpenAI client at http://' +
      GATEKEEPER_LISTEN +
      '/v1.',
  },
];

/** All four, in order, for the one-shot copy button. */
export function setupScript(): string {
  return SETUP_STEPS.map((step) => step.command).join('\n');
}

/**
 * The same four commands with the placeholders filled in.
 *
 * The Gatekeeper screen shows the generic form because it is reached before the
 * user has chosen an endpoint. The chat's "verify this yourself" panel is the
 * opposite situation: it already knows which hostname it just verified and which
 * digest that evidence carried, so it can hand over commands that need no editing
 * — which is the difference between a quick-start a reader skims and one they run.
 *
 * An absent digest leaves `sha256:<evidenceDigest>` in place rather than pasting
 * an empty pin: a `trust add` with nothing after it would be a command that looks
 * complete and trusts nothing.
 */
export function resolvedSetupSteps(input: { hostname: string; evidenceDigestHex?: string | null }): SetupStep[] {
  return SETUP_STEPS.map((step) => ({
    ...step,
    command: step.command
      .replace('https://<hostname>', `https://${input.hostname}`)
      .replace(
        'sha256:<evidenceDigest>',
        input.evidenceDigestHex ? `sha256:${input.evidenceDigestHex}` : 'sha256:<evidenceDigest>',
      ),
  }));
}

/** All four resolved commands, in order, for the one-shot copy button. */
export function resolvedSetupScript(input: { hostname: string; evidenceDigestHex?: string | null }): string {
  return resolvedSetupSteps(input)
    .map((step) => step.command)
    .join('\n');
}
