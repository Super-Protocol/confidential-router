import './react-flow-jsdom';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  DECLARED_IMAGES,
  gateEvidence as evidence,
  PASSING_GATE_CHECKS as PASSING_CHECKS,
  SIGNED_SNAPSHOT,
  verificationState as verification,
} from '../../../test-fixtures';
import type { VerificationState } from '../verification/use-verification';
import AttestationInspector from './inspector';

/**
 * What the panel says, and — more to the point — what it refuses to say.
 *
 * The graph's own logic is held to `graph-model.spec.ts`; these cases are about
 * the panel as a *claim*: that it reuses the chat's verification rather than
 * re-running it, that a failed tier 1 produces no graph at all, and that the
 * measurements the issue asks for parity on are each on screen with a value.
 */

const HOSTNAME = 'llama-33-70b.tee.swarm.cloud';

function open(state: VerificationState = verification(), declaredImages = DECLARED_IMAGES) {
  return render(
    <AttestationInspector
      open
      onOpenChange={vi.fn()}
      verification={state}
      hostname={HOSTNAME}
      teeLabel="Intel TDX + H100 CC"
      declaredImages={declaredImages}
    />,
  );
}

/** The `<dd>` beside a field's label, whatever the panel put in it. */
function fieldValue(label: string): HTMLElement {
  const term = screen.getByText(label, { selector: 'dt' });
  const value = term.nextElementSibling;
  if (!(value instanceof HTMLElement)) throw new Error(`no value beside "${label}"`);
  return value;
}

describe('the measurements panel', () => {
  it('carries every field the Chrome extension shows, with a value', () => {
    // Parity floor: the extension's `EvidenceDetails` rows. Each has to be here
    // and each has to be populated — a row that renders "not published" for a
    // value the bundle carries would pass a smoke test and fail a reader.
    open();

    expect(fieldValue('Hostname')).toHaveTextContent(HOSTNAME);
    expect(fieldValue('Root')).toHaveTextContent('Super Swarm Root CA');
    expect(fieldValue('Certificate fingerprint')).toHaveTextContent(
      'sha256:3e643b751db15af07d0a4139b0cd5f4e767869887a51b2e9d068d7a08795c0db',
    );
    expect(fieldValue('Channel binding')).toHaveTextContent('producer-asserted');
    expect(fieldValue('Evidence digest')).toHaveTextContent(
      'sha256:f579367d3d6942f03b05d138acbd1e426dd7913a59f2f35cd58b16b87809a00b',
    );
    expect(fieldValue('Root CA TEE quote format')).toHaveTextContent('publishes no usable rootCaTeeQuote');
    expect(fieldValue('Signed at')).not.toHaveTextContent('not published');
    expect(fieldValue('Checked in this page')).not.toHaveTextContent('not published');
  });

  it('shows the TCB level and the report policy bits the extension does not', () => {
    open();

    expect(fieldValue('TCB level (SNP firmware)')).toHaveTextContent('27');
    expect(fieldValue('Guest policy')).toHaveTextContent('0x30000');
    expect(fieldValue('Debug')).toHaveTextContent('not permitted');
    expect(fieldValue('VMPL / report version')).toHaveTextContent('0 / v5');
  });

  it('renders fingerprints in hex, the spelling the rest of the console uses', () => {
    // SUP-115: every user-facing surface prints `sha256:<hex>`. The canonical
    // base64url form is kept beside it, because that is what the bundle carries.
    open();
    const digest = fieldValue('Evidence digest');

    expect(digest).toHaveTextContent('sha256/9Xk2fT1pQvA7BdE4rL0eQm3XkTpZ8vNc1YsWuHgJoAs');
    expect(digest.querySelector('.font-mono')?.textContent).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('offers a copy button per value rather than one for the panel', async () => {
    open();

    expect(screen.getByRole('button', { name: 'Copy Evidence digest' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy Certificate fingerprint' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /Copy the signed evidence/ })).toBeInTheDocument();
  });

  it('refuses to call the operator’s TEE label a check', () => {
    // The one field most likely to be read as hardware attestation. It is config.
    open();

    expect(fieldValue('TEE, as the operator declares it')).toHaveTextContent('nothing on this page checks it');
  });

  it('lists every image the signed evidence carries, with its verdict', () => {
    open();

    expect(screen.getByText(/Images the signed evidence carries \(4\)/)).toBeInTheDocument();
    expect(fieldValue('router-api')).toHaveTextContent(
      'ghcr.io/super-protocol/router-api@sha256:1111111111111111111111111111111111111111111111111111111111111111',
    );
    expect(fieldValue('migrate')).toHaveTextContent('init container');
  });

  it('says nothing was compared when the endpoint declares no allow-list', () => {
    open(verification(), null as unknown as typeof DECLARED_IMAGES);

    expect(fieldValue('router-api')).toHaveTextContent('declares no image allow-list');
  });

  it('names the undeclared image loudly when the evidence carries one', () => {
    const doctored = structuredClone(SIGNED_SNAPSHOT) as {
      resources: { kind: string; metadata?: { name: string } }[];
    };
    const deployment = doctored.resources.find(
      (resource) => resource.kind === 'Deployment' && resource.metadata?.name === 'router-api',
    ) as unknown as { spec: { template: { spec: { containers: { image: string }[] } } } };
    (deployment.spec.template.spec.containers[0] as { image: string }).image =
      `docker.io/library/nginx@sha256:${'4'.repeat(64)}`;

    open(
      verification({
        gate: {
          unlocked: true,
          checks: PASSING_CHECKS,
          registry: null,
          evidence: evidence({ snapshot: doctored }),
        },
      }),
    );

    expect(within(fieldValue('router-api')).getByText(/declaration does not mention it at all/)).toBeInTheDocument();
  });
});

describe('the deployment graph tab', () => {
  it('says the graph is drawn from the signed evidence, not from an API', async () => {
    open();
    await userEvent.click(screen.getByRole('tab', { name: 'Deployment graph' }));

    expect(screen.getByText('Drawn from the signed evidence.')).toBeInTheDocument();
    expect(screen.getByText(/The graph is the attested document/)).toBeInTheDocument();
  });

  it('makes every node a button, so the graph is walkable from the keyboard', async () => {
    open();
    await userEvent.click(screen.getByRole('tab', { name: 'Deployment graph' }));

    const graph = screen.getByRole('figure', { name: /Deployment graph/ });
    const nodes = within(graph).getAllByRole('button');

    // Two ingress hosts, three services, three workloads, four containers — plus
    // react-flow's own zoom controls, which are buttons too.
    expect(nodes.length).toBeGreaterThanOrEqual(12);
    expect(within(graph).getByRole('button', { name: /^Ingress host llama-33-70b/ })).toBeInTheDocument();
    expect(within(graph).getByRole('button', { name: /^Service router-api/ })).toBeInTheDocument();
    expect(within(graph).getByRole('button', { name: /^Workload router-api/ })).toBeInTheDocument();
  });

  it('spells a container’s digest and verdict into its accessible name', async () => {
    // A reader who cannot see that a box is red has to hear why it is.
    open();
    await userEvent.click(screen.getByRole('tab', { name: 'Deployment graph' }));

    expect(
      screen.getByRole('button', {
        name: /Container litellm.*image ghcr\.io\/berriai\/litellm@sha256:2+.*digest declared by the operator/s,
      }),
    ).toBeInTheDocument();
  });

  it('opens a node’s raw signed fields', async () => {
    open();
    await userEvent.click(screen.getByRole('tab', { name: 'Deployment graph' }));
    await userEvent.click(screen.getByRole('button', { name: /^Service litellm/ }));

    const drawer = await screen.findByRole('dialog', { name: 'litellm' });
    expect(within(drawer).getByText(/out of the signed evidence/)).toBeInTheDocument();
    expect(within(drawer).getByText(/"kind": "Service"/)).toBeInTheDocument();
  });

  it('names the kinds the signed document carries and the graph does not draw', async () => {
    open();
    await userEvent.click(screen.getByRole('tab', { name: 'Deployment graph' }));

    expect(screen.getByText(/1 ConfigMap, 1 Secret/)).toBeInTheDocument();
  });
});

describe('when the evidence did not check out', () => {
  it('draws no graph and says why, in the words of the failing check', async () => {
    // The property the whole feature turns on. `runEvidenceGate` already returns
    // no evidence on a failure, so this is belt and braces — but a panel that
    // rendered an empty canvas here would read as "this deployment runs nothing".
    open(
      verification({
        gate: {
          unlocked: false,
          checks: [{ id: 'signature', status: 'fail', detail: 'The signature did not verify: bad digest.' }],
          registry: null,
          evidence: null,
        },
        pageState: 'fail',
        unlocked: false,
      }),
    );

    expect(screen.queryByRole('tab', { name: 'Deployment graph' })).not.toBeInTheDocument();
    expect(screen.getByText(/Nothing below is drawn from this endpoint’s evidence/)).toBeInTheDocument();
    expect(screen.getByText('The signature did not verify: bad digest.')).toBeInTheDocument();
  });

  it('carries the badge’s own caveat rather than a milder one of its own', () => {
    // This panel is the one most likely to be mistaken for a verdict: it has the
    // measurements and the graph on it. Every verification string still comes
    // from `verification/tiers.ts`.
    open();

    expect(screen.getByText(/came from the same deployment, so this is self-reported/)).toBeInTheDocument();
  });

  it('re-runs the chat’s own verification rather than starting a second one', async () => {
    const recheck = vi.fn();
    open(verification({ recheck }));

    await userEvent.click(screen.getByRole('button', { name: /Check again/ }));

    expect(recheck).toHaveBeenCalledTimes(1);
  });

  it('says it is still checking while tier 1 is outstanding', () => {
    open(verification({ gate: null, checkedAt: null, pageState: 'pending', unlocked: false }));

    expect(screen.getByRole('status')).toHaveTextContent(/checking it here in your browser/);
  });
});
