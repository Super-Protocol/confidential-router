import type { MockLink } from '@apollo/client/testing';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { OverviewQuery } from '../../generated/graphql';
import { evidenceSnapshot, overviewData, publishedEndpoint, unpublishedEndpoint } from '../../test-fixtures';
import { renderWithSession, sessionMock } from '../../test-utils';
import { OVERVIEW_QUERY, OverviewScreen } from './overview-screen';

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
}));

/**
 * The range is derived from the current UTC day, so the mock matches on any
 * variables rather than re-deriving the same clock arithmetic in the test.
 */
function overviewMock(data: OverviewQuery, options: { delay?: number } = {}): MockLink.MockedResponse {
  return {
    request: { query: OVERVIEW_QUERY, variables: () => true },
    result: { data },
    maxUsageCount: Number.POSITIVE_INFINITY,
    ...options,
  };
}

function renderOverview(mocks: MockLink.MockedResponse[]) {
  return renderWithSession(<OverviewScreen />, { mocks: [sessionMock(), ...mocks] });
}

describe('OverviewScreen', () => {
  it('says it is busy while the workspace loads', () => {
    renderOverview([overviewMock(overviewData(), { delay: 1000 })]);

    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByRole('group', { name: 'Spend' })).not.toBeInTheDocument();
  });

  it('shows the period’s spend, traffic and evidence coverage', async () => {
    renderOverview([overviewMock(overviewData())]);

    const spend = await screen.findByRole('group', { name: 'Spend' });
    expect(within(spend).getByText('$149.34')).toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: 'Requests' })).getByText('10.9K')).toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: 'Tokens' })).getByText('780.3M')).toBeInTheDocument();

    const coverage = screen.getByRole('group', { name: 'Evidence coverage' });
    expect(within(coverage).getByText('100%')).toBeInTheDocument();
    // A publication rate, never a verification rate (ADR-002).
    expect(coverage).toHaveTextContent('10.9K of 10.9K generations were served while the endpoint had a fresh bundle');
  });

  it('does not imply coverage when nothing was served', async () => {
    renderOverview([
      overviewMock(
        overviewData({
          activitySummary: {
            spendMicros: '0',
            requests: 0,
            promptTokens: 0,
            completionTokens: 0,
            coveredRequests: 0,
            coverableRequests: 0,
            evidenceCoverage: null,
          },
        }),
      ),
    ]);

    const coverage = await screen.findByRole('group', { name: 'Evidence coverage' });
    expect(within(coverage).getByText('—')).toBeInTheDocument();
    expect(coverage).toHaveTextContent('No generations were served in this period.');
  });

  it('says coverage does not apply, rather than 0%, when every generation was external', async () => {
    // SUP-421, from production: 34 generations, every one served by an external
    // endpoint this router had verified and whose digest each row carries. The
    // tile read "Evidence coverage 0% — 0 of 34 generations were served while
    // the endpoint had a fresh bundle published", which is the product's central
    // claim reported as never kept.
    renderOverview([
      overviewMock(
        overviewData({
          activitySummary: {
            spendMicros: '100738',
            requests: 34,
            promptTokens: 1_000,
            completionTokens: 500,
            coveredRequests: 0,
            coverableRequests: 0,
            evidenceCoverage: null,
          },
        }),
      ),
    ]);

    const coverage = await screen.findByRole('group', { name: 'Evidence coverage' });
    expect(within(coverage).queryByText('0%')).not.toBeInTheDocument();
    expect(within(coverage).getByText('—')).toBeInTheDocument();
    expect(coverage).toHaveTextContent('coverage does not apply here');
    expect(coverage).toHaveTextContent('all 34 generations were served by external endpoints');
    expect(coverage).toHaveTextContent('verified by this router');
  });

  it('counts the ratio over this platform’s endpoints and says where the rest went', async () => {
    renderOverview([
      overviewMock(
        overviewData({
          activitySummary: {
            spendMicros: '5000',
            requests: 50,
            promptTokens: 1_000,
            completionTokens: 500,
            coveredRequests: 8,
            coverableRequests: 10,
            evidenceCoverage: 0.8,
          },
        }),
      ),
    ]);

    const coverage = await screen.findByRole('group', { name: 'Evidence coverage' });
    expect(within(coverage).getByText('80%')).toBeInTheDocument();
    expect(coverage).toHaveTextContent('8 of 10 generations on this platform’s own endpoints');
    expect(coverage).toHaveTextContent('The other 40 went to external endpoints, verified by this router.');
  });

  it('lists each endpoint with the digest a gatekeeper pins', async () => {
    renderOverview([overviewMock(overviewData())]);

    const row = within(await screen.findByRole('table', { name: 'Confidential endpoints' })).getByRole('row', {
      name: /llama-33-70b\.tee\.swarm\.cloud/,
    });
    expect(within(row).getByText('Intel TDX (GCP)')).toBeInTheDocument();
    // Hex, the spelling every Super Protocol surface shows (SUP-115).
    expect(within(row).getByText('sha256:f57936…09a00b')).toBeInTheDocument();
    expect(within(row).getByText('598M')).toBeInTheDocument();
  });

  it('labels the TEE from the published evidence, and names none without it (SUP-270)', async () => {
    renderOverview([
      overviewMock(
        overviewData({
          endpoints: [
            {
              // What production published, under the hostname that used to be
              // labelled "Intel TDX + H100 CC" by the chart's one default.
              ...publishedEndpoint({ latestEvidence: evidenceSnapshot({ tee: 'AMD SEV-SNP (Azure)' }) }),
              tokensRouted30d: 0,
            },
            { ...unpublishedEndpoint(), tokensRouted30d: 0 },
          ],
        }),
      ),
    ]);

    const table = await screen.findByRole('table', { name: 'Confidential endpoints' });
    const prod = within(table).getByRole('row', { name: /llama-33-70b\.tee\.swarm\.cloud/ });
    expect(within(prod).getByText('AMD SEV-SNP (Azure)')).toBeInTheDocument();
    // Nothing published, nothing named: there is no declared label to fill the
    // gap with any more (SUP-260).
    const unpublished = within(table).getByRole('row', { name: /qwen25-72b\.tee\.swarm\.cloud/ });
    expect(within(unpublished).getAllByText('—').length).toBeGreaterThan(0);
    expect(within(table).queryByText('Intel TDX + H100 CC')).not.toBeInTheDocument();
  });

  it('copies the full hex digest, not the truncated one on screen', async () => {
    const user = userEvent.setup();
    renderOverview([overviewMock(overviewData())]);

    await user.click(
      await screen.findByRole('button', { name: 'Copy evidence digest for llama-33-70b.tee.swarm.cloud' }),
    );

    // What lands on the clipboard is what `gatekeeper endpoint trust add` takes.
    await expect(navigator.clipboard.readText()).resolves.toBe(
      `sha256:${publishedEndpoint().latestEvidence?.evidenceDigestHex}`,
    );
  });

  it('opens the evidence modal from a row', async () => {
    const user = userEvent.setup();
    renderOverview([overviewMock(overviewData())]);

    await user.click(await screen.findByRole('button', { name: 'Evidence for deepseek-v3.tee.swarm.cloud: Stale' }));

    expect(await screen.findByRole('dialog')).toHaveTextContent('Signing key rotating');
  });

  it('says so when the router publishes no endpoints', async () => {
    renderOverview([overviewMock(overviewData({ endpoints: [] }))]);

    expect(await screen.findByText('No endpoints yet')).toBeInTheDocument();
  });

  it('offers a retry when the query fails outright', async () => {
    renderOverview([
      {
        request: { query: OVERVIEW_QUERY, variables: () => true },
        error: new Error('network down'),
      },
    ]);

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
