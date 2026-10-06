/**
 * The sequence that takes a reader from nothing to a verifying proxy, with
 * every value this deployment already knows filled in.
 *
 * Kept as data rather than markup so the two screens that show it — `/gatekeeper`
 * and the chat's "what has been verified" panel — and the tests that pin the
 * text all read one set of strings. A command a user pastes is part of the
 * product's contract with the gatekeeper CLI (`apps/gatekeeper/pkg/cli`).
 *
 * Nothing it returns contains an angle-bracket placeholder, and
 * `setup-commands.spec.ts` holds it to that. A page that printed
 * `--upstream https://<hostname>` to a reader who arrived from the very
 * deployment that *is* the hostname made them edit a command the console could
 * have written — which is a quick-start you skim rather than one you run
 * (SUP-193).
 *
 * The order and the wording track the landing page's verified quick-start
 * (`confidential-router-landing`, `src/content/code-samples.ts`, SUP-155).
 */

import { type InstallCommand, installStepsSentence } from './install-commands';

/** The listen address the console suggests everywhere, including the snippet. */
export const GATEKEEPER_LISTEN = '127.0.0.1:8787';

/** The endpoint name used throughout the docs; any name works. */
export const ENDPOINT_NAME = 'router';

/** The trust-store name the Swarm cloud's CA is filed under; any name works. */
export const TRUST_ROOT_NAME = 'swarm-prod';

export type SetupStepId = 'install' | 'init' | 'trust-root' | 'endpoint' | 'pin' | 'run';

export interface SetupStep {
  /** Stable across wording changes, so a test can name a step without counting. */
  id: SetupStepId;
  command: string;
  title: string;
  detail: string;
}

export interface SetupInput {
  /**
   * The origin the gatekeeper fronts, scheme included — `publicConfig().apiOrigin`
   * on the Gatekeeper page, and the endpoint the chat has just verified in the
   * panel. Both are this deployment's own API origin whenever the console and
   * the endpoint are the same deployment, which is the only case either screen
   * can speak for.
   */
  upstream: string;
  /** Where the Swarm cloud's root CA is published — `publicConfig().swarmRootPemUrl`. */
  swarmRootPemUrl: string;
  /** The shell the two piped lines are written for. */
  platform: InstallCommand;
  /**
   * The digest to pin outright. Absent takes the published one with
   * `--from-upstream`, which verifies and prints before it writes anything —
   * never a `sha256:<evidenceDigest>` the reader has to go and find.
   */
  evidenceDigestHex?: string | null;
}

/**
 * The whole sequence, in the order it is run.
 *
 * `--from-upstream` rather than a placeholder pin is the substantive difference
 * between the two callers: the chat panel knows which digest the evidence it
 * just checked carried, and the Gatekeeper page is reached before any endpoint
 * is chosen. Both commands are complete as printed; one pins what the console
 * read, the other pins what the gatekeeper reads for itself and shows you.
 */
export function setupSteps(input: SetupInput): SetupStep[] {
  const { upstream, swarmRootPemUrl, platform, evidenceDigestHex } = input;

  return [
    {
      id: 'install',
      command: platform.command,
      title: `Install it — ${platform.platform}`,
      detail: `${installStepsSentence()} Nobody should paste a one-liner from the internet on trust alone, so that is what this one does.`,
    },
    {
      id: 'init',
      command: 'gatekeeper init',
      title: 'Write a starter config',
      detail:
        'Creates ~/.config/confidential-gatekeeper/config.yaml with the default policy. Nothing is contacted, and the file it writes admits nothing until an endpoint has a pin.',
    },
    {
      id: 'trust-root',
      command: platform.trustRoot(TRUST_ROOT_NAME, swarmRootPemUrl),
      title: 'Trust the Swarm cloud\u2019s certificate authority',
      detail:
        'Gatekeeper ships with an empty trust store and no trust-on-first-use, so the CA that signs a Swarm cloud’s evidence has to get in somehow. It is fetched from where Super Protocol publishes it rather than from the endpoint under inspection: a root taken from the thing it vouches for would prove nothing.',
    },
    {
      id: 'endpoint',
      command: `gatekeeper endpoint add ${ENDPOINT_NAME} --upstream ${upstream} --listen ${GATEKEEPER_LISTEN}`,
      title: 'Front this endpoint',
      detail: `The upstream is this deployment’s API origin; ${GATEKEEPER_LISTEN} is what your agents will point at instead. Nothing is registered with the router at any point — it never learns that a gatekeeper exists.`,
    },
    evidenceDigestHex
      ? {
          id: 'pin',
          command: `gatekeeper endpoint trust add ${ENDPOINT_NAME} sha256:${evidenceDigestHex}`,
          title: 'Pin what you are willing to trust',
          detail:
            'The digest this router published for the deployment you are talking to — the same sha256: string the gatekeeper prints back. Only a bundle whose digest you pinned here passes: the router cannot add one, and a digest that changes is a deployment you have not approved.',
        }
      : {
          id: 'pin',
          command: `gatekeeper endpoint trust add ${ENDPOINT_NAME} --from-upstream`,
          title: 'Pin what you are willing to trust',
          detail:
            '--from-upstream is not trust-on-first-use: it verifies the endpoint first, prints the chain, the quote format and the evidenceDigest it found, and pins only what you then confirm. Compare that digest with the one Overview shows before you accept it.',
        },
    {
      id: 'run',
      command: 'gatekeeper run',
      title: 'Run it',
      detail: `Verifies before it forwards, re-attests on its own schedule, and refuses the request if any check fails. Point your OpenAI client at http://${GATEKEEPER_LISTEN}/v1.`,
    },
  ];
}

/** The whole sequence as one script, for the copy-all button. */
export function setupScript(input: SetupInput): string {
  return setupSteps(input)
    .map((step) => step.command)
    .join('\n');
}

/**
 * The command for a stand whose image the Super Protocol registry has never
 * signed.
 *
 * It is a footnote rather than a seventh step on purpose: the six steps are the
 * path, and a Swarm cloud's certificate authority is normally accepted on its
 * own TEE evidence with nothing to paste. This is what to reach for when step 5
 * denies with "not in the Super Protocol trusted registry" — which happens on a
 * stand built outside the flow that publishes those signatures.
 */
export const UNSIGNED_MEASUREMENT_COMMAND = `gatekeeper trust measurements add --from-upstream ${ENDPOINT_NAME}`;

export const UNSIGNED_MEASUREMENT_NOTE =
  'If the gatekeeper denies with \u201cnot in the Super Protocol trusted registry\u201d, this cloud\u2019s ' +
  'image was built outside the flow that publishes those signatures. You can accept its measurement ' +
  'yourself \u2014 the command prints the full hardware report and asks first. Everything else still has ' +
  'to pass, and a root admitted this way is reported as \u201cattested (operator-pinned)\u201d, never as ' +
  'registry-signed.';
