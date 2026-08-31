import type { MockLink } from '@apollo/client/testing';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { evidenceSnapshot, publishedEndpoint, rotatingEndpoint, unpublishedEndpoint } from '../../test-fixtures';
import { renderWithApollo } from '../../test-utils';
import { EvidenceModal } from './evidence-modal';
import { REFRESH_EVIDENCE } from './queries';

function refreshMock(endpointId: string, snapshot: unknown, error?: Error): MockLink.MockedResponse {
  return {
    request: { query: REFRESH_EVIDENCE, variables: { endpointId } },
    ...(error ? { error } : { result: { data: { refreshEvidence: snapshot } } }),
  };
}

function open(endpoint: Parameters<typeof EvidenceModal>[0]['endpoint'], mocks: MockLink.MockedResponse[] = []) {
  return renderWithApollo(<EvidenceModal endpoint={endpoint} open onOpenChange={vi.fn()} />, { mocks });
}

describe('EvidenceModal', () => {
  it('shows what a published endpoint published, without claiming it verified', () => {
    open(publishedEndpoint());

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Evidence published' })).toBeInTheDocument();
    expect(within(dialog).getByText('llama-33-70b.tee.swarm.cloud')).toBeInTheDocument();
    expect(within(dialog).getByText('intel-tdx-quote-v5')).toBeInTheDocument();
    expect(within(dialog).getByText('vllm-tdx@sha256:6b1f9c04')).toBeInTheDocument();
    expect(within(dialog).getByText(/12s ago/)).toBeInTheDocument();
    expect(within(dialog).getByText(/issued 2026-08-31 09:28 UTC/)).toBeInTheDocument();

    // ADR-002: the console never renders a verdict.
    expect(dialog.textContent).not.toMatch(/verified|unverified|valid|trusted root/i);
  });

  it('lists the measurement registers the producer published', () => {
    open(publishedEndpoint());

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('MRTD')).toBeInTheDocument();
    expect(within(dialog).getByText('91f4a27c8bd0e5137ac64e0b9d')).toBeInTheDocument();
    expect(within(dialog).getByText('GPU')).toBeInTheDocument();
  });

  it('walks the chain leaf to root and names the root it terminates at', () => {
    open(publishedEndpoint());

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('CN=llama-33-70b.tee.swarm.cloud')).toBeInTheDocument();
    expect(within(dialog).getByText(/The published chain terminates at CN=swarm-cloud-prod/)).toBeInTheDocument();
  });

  it('says the signing key is rotating when the last bundle is stale', () => {
    open(rotatingEndpoint());

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Signing key rotating' })).toBeInTheDocument();
    expect(within(dialog).getByText(/a fresh quote is being issued. Verify again shortly/)).toBeInTheDocument();
    // The stale bundle is still shown — it is what the endpoint last published.
    expect(within(dialog).getByText(/12 min ago/)).toBeInTheDocument();
  });

  it('offers nothing to copy when the platform publishes no bundle', () => {
    open(unpublishedEndpoint());

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Nothing published' })).toBeInTheDocument();
    expect(within(dialog).getByText(/no published bundle to show/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Copy evidence JWS' })).toBeDisabled();
  });

  it('copies the compact JWS as published', async () => {
    const user = userEvent.setup();
    open(publishedEndpoint());

    await user.click(screen.getByRole('button', { name: 'Copy evidence JWS' }));

    await expect(navigator.clipboard.readText()).resolves.toBe(publishedEndpoint().latestEvidence?.jws);
  });

  it('re-polls the endpoint and shows the newer quote', async () => {
    const user = userEvent.setup();
    const fresher = evidenceSnapshot({ id: 'snap-9', quoteAgeSeconds: 3, issuedAt: '2026-08-31T10:00:00.000Z' });
    const onRefreshed = vi.fn();

    renderWithApollo(
      <EvidenceModal endpoint={rotatingEndpoint()} open onOpenChange={vi.fn()} onRefreshed={onRefreshed} />,
      { mocks: [refreshMock('ep-2', fresher)] },
    );

    await user.click(screen.getByRole('button', { name: /Fetch fresh quote/ }));

    await waitFor(() => expect(screen.getByText(/3s ago/)).toBeInTheDocument());
    // The endpoint's own state can change too, and the mutation does not carry
    // it — the screen that owns the query is asked to refetch.
    expect(onRefreshed).toHaveBeenCalled();
  });

  it('reports a re-poll that fails instead of leaving the old quote looking fresh', async () => {
    const user = userEvent.setup();

    renderWithApollo(<EvidenceModal endpoint={publishedEndpoint()} open onOpenChange={vi.fn()} />, {
      mocks: [refreshMock('ep-1', null, new Error('unreachable'))],
    });

    await user.click(screen.getByRole('button', { name: /Fetch fresh quote/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not fetch a fresh quote');
  });

  it('handles a re-poll that finds nothing published', async () => {
    const user = userEvent.setup();

    renderWithApollo(<EvidenceModal endpoint={publishedEndpoint()} open onOpenChange={vi.fn()} />, {
      mocks: [refreshMock('ep-1', null)],
    });

    await user.click(screen.getByRole('button', { name: /Fetch fresh quote/ }));

    expect(await screen.findByText(/no published bundle to show/)).toBeInTheDocument();
  });
});
