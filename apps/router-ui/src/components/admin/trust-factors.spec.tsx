import type { MockLink } from '@apollo/client/testing';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { isAdminMock, renderWithSession, sessionMock } from '../../test-utils';
import {
  AWAITING_APPROVAL_ENDPOINT,
  DIGEST_APPROVED,
  DIGEST_REDEPLOYED,
  endpointsMock,
  MEASUREMENT_ROGUE,
  measurementsMock,
  REDEPLOYED_ENDPOINT,
  TRUSTED,
  VERIFIED_ENDPOINT,
} from './admin-mocks';
import { ExternalEndpointsScreen } from './external-endpoints-screen';
import { ADD_TRUSTED_MEASUREMENT, PIN_EXTERNAL_ENDPOINT_DIGEST } from './operations';
import { digestFactorState } from './trust-factors';

vi.mock('next/navigation', () => ({
  usePathname: () => '/admin/endpoints',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
}));

vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 5_000 });

function renderScreen({ admin = true, mocks }: { admin?: boolean; mocks: MockLink.MockedResponse[] }) {
  return renderWithSession(<ExternalEndpointsScreen />, {
    mocks: [sessionMock(), isAdminMock(admin), measurementsMock([TRUSTED]), ...mocks],
  });
}

async function openDossier(name: string) {
  await userEvent.click(await screen.findByRole('button', { name: new RegExp(`^Open ${name}:`) }));
  const drawer = await screen.findByRole('dialog');
  return within(drawer).findByTestId('trust-factors');
}

describe('digestFactorState', () => {
  it('reads the deployment factor off the pin and the digest seen', () => {
    expect(digestFactorState(AWAITING_APPROVAL_ENDPOINT)).toBe('not-pinned');
    expect(digestFactorState(VERIFIED_ENDPOINT)).toBe('pinned');
    expect(digestFactorState(REDEPLOYED_ENDPOINT)).toBe('changed');
    expect(digestFactorState({ ...VERIFIED_ENDPOINT, evidenceDigestSeen: null })).toBe('not-seen');
  });
});

/**
 * SUP-252: an external endpoint is admitted only when its cloud's measurement is
 * on the trust list *and* its deployment's evidence digest is the one pinned for
 * it. The dossier shows both factors and approves each with one click.
 */
describe('the trust factors in the dossier', () => {
  it('shows both factors a first check saw, neither approved yet, each with its approve button', async () => {
    renderScreen({ mocks: [endpointsMock([AWAITING_APPROVAL_ENDPOINT])] });
    const factors = await openDossier('llama-demo');

    const measurement = within(factors).getByTestId('trust-factor-measurement');
    expect(await within(measurement).findByText('Not on the trust list')).toBeInTheDocument();
    // Informational: the registry signature is what the admin is vouching for,
    // not what admits.
    expect(within(measurement).getByText('Registry-signed')).toBeInTheDocument();
    expect(await within(measurement).findByRole('button', { name: 'Add to trust list' })).toBeInTheDocument();

    const digest = within(factors).getByTestId('trust-factor-digest');
    expect(within(digest).getByText('Not pinned')).toBeInTheDocument();
    expect(within(digest).getByRole('button', { name: 'Pin this digest' })).toBeInTheDocument();
  });

  it('adds the measurement seen to the trust list in one click', async () => {
    const added = vi.fn(() => ({
      data: {
        addTrustedMeasurement: {
          ...TRUSTED,
          id: 'tm-new',
          measurement: MEASUREMENT_ROGUE,
          note: 'Approved from the llama-demo dossier',
        },
      },
    }));
    renderScreen({
      mocks: [
        endpointsMock([AWAITING_APPROVAL_ENDPOINT]),
        {
          request: {
            query: ADD_TRUSTED_MEASUREMENT,
            variables: { input: { measurement: MEASUREMENT_ROGUE, note: 'Approved from the llama-demo dossier' } },
          },
          result: added,
        },
      ],
    });
    const factors = await openDossier('llama-demo');

    await userEvent.click(await within(factors).findByRole('button', { name: 'Add to trust list' }));

    await waitFor(() => expect(added).toHaveBeenCalledTimes(1));
  });

  it('pins the digest seen in one click', async () => {
    const pinned = vi.fn(() => ({
      data: {
        pinExternalEndpointDigest: {
          ...AWAITING_APPROVAL_ENDPOINT,
          pinnedEvidenceDigest: DIGEST_APPROVED,
          pinnedEvidenceDigestHex: AWAITING_APPROVAL_ENDPOINT.evidenceDigestSeenHex,
        },
      },
    }));
    renderScreen({
      mocks: [
        endpointsMock([AWAITING_APPROVAL_ENDPOINT]),
        {
          request: {
            query: PIN_EXTERNAL_ENDPOINT_DIGEST,
            variables: { id: AWAITING_APPROVAL_ENDPOINT.id, input: { evidenceDigest: DIGEST_APPROVED } },
          },
          result: pinned,
        },
      ],
    });
    const factors = await openDossier('llama-demo');

    await userEvent.click(within(factors).getByRole('button', { name: 'Pin this digest' }));

    // What the factor reads afterwards is the server's next answer — the dossier
    // keeps polling an endpoint that is not admitted — so the assertion is on the
    // request that was sent: the canonical digest the verdict reported.
    await waitFor(() => expect(pinned).toHaveBeenCalledTimes(1));
  });

  it('after a redeploy, shows the approved and the new digest, what changed, and approves the new one', async () => {
    const approved = vi.fn(() => ({
      data: {
        pinExternalEndpointDigest: {
          ...REDEPLOYED_ENDPOINT,
          pinnedEvidenceDigest: DIGEST_REDEPLOYED,
          pinnedEvidenceDigestHex: REDEPLOYED_ENDPOINT.evidenceDigestSeenHex,
        },
      },
    }));
    renderScreen({
      mocks: [
        endpointsMock([REDEPLOYED_ENDPOINT]),
        {
          request: {
            query: PIN_EXTERNAL_ENDPOINT_DIGEST,
            variables: { id: REDEPLOYED_ENDPOINT.id, input: { evidenceDigest: DIGEST_REDEPLOYED } },
          },
          result: approved,
        },
      ],
    });
    const factors = await openDossier('llama-redeployed');

    const digest = within(factors).getByTestId('trust-factor-digest');
    expect(within(digest).getByText('Changed — not approved')).toBeInTheDocument();
    const change = within(digest).getByTestId('digest-change');
    expect(within(change).getByText('Approved')).toBeInTheDocument();
    expect(within(change).getByText('Now publishing')).toBeInTheDocument();
    // The evidence summary diff the decision is made from: the image the redeploy
    // replaced, and the one it brought in.
    const diff = within(change).getByRole('list', { name: 'What changed' });
    expect(within(diff).getByText(/vllm@sha256:3333/)).toBeInTheDocument();
    expect(within(diff).getByText(/vllm@sha256:1111/)).toBeInTheDocument();

    await userEvent.click(within(digest).getByRole('button', { name: 'Approve new digest' }));

    await waitFor(() => expect(approved).toHaveBeenCalledTimes(1));
  });

  it('shows a verified endpoint with both factors held and nothing to approve', async () => {
    renderScreen({ mocks: [endpointsMock([VERIFIED_ENDPOINT])] });
    const factors = await openDossier('qwen3-coder');

    expect(await within(factors).findByText('On the trust list')).toBeInTheDocument();
    expect(within(factors).getByText('Pinned')).toBeInTheDocument();
    expect(within(factors).getByText('Approved digest')).toBeInTheDocument();
    for (const action of ['Add to trust list', 'Pin this digest', 'Approve new digest']) {
      expect(within(factors).queryByRole('button', { name: action })).not.toBeInTheDocument();
    }
  });

  it('shows a signed-in non-admin both factors and the pin, and no approve button (ruling 3)', async () => {
    renderScreen({ admin: false, mocks: [endpointsMock([AWAITING_APPROVAL_ENDPOINT])] });
    const factors = await openDossier('llama-demo');

    expect(await within(factors).findByText('Not on the trust list')).toBeInTheDocument();
    expect(within(factors).getByText('Not pinned')).toBeInTheDocument();
    expect(within(factors).queryByRole('button', { name: 'Add to trust list' })).not.toBeInTheDocument();
    expect(within(factors).queryByRole('button', { name: 'Pin this digest' })).not.toBeInTheDocument();
  });
});
