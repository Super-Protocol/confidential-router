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
    command: `gatekeeper endpoint trust add ${ENDPOINT_NAME} <evidenceDigest>`,
    title: 'Pin what you are willing to trust',
    detail:
      'Copy the evidenceDigest from Overview. Only a bundle whose digest you pinned here passes — the router cannot add one, and a digest that changes is a deployment you have not approved.',
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
