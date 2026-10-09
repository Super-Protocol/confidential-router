import type { MockLink } from '@apollo/client/testing';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { ModelCatalogueQuery } from '../../generated/graphql';
import { catalogueData, externalModel, verifiedUpstream } from '../../test-fixtures';
import { renderWithApollo } from '../../test-utils';
import { MODEL_CATALOGUE_QUERY, ModelsScreen } from './models-screen';

function catalogueMock(data: ModelCatalogueQuery, options: { delay?: number } = {}): MockLink.MockedResponse {
  return {
    request: { query: MODEL_CATALOGUE_QUERY },
    result: { data },
    maxUsageCount: Number.POSITIVE_INFINITY,
    ...options,
  };
}

describe('ModelsScreen', () => {
  it('says it is busy while the catalogue loads', () => {
    renderWithApollo(<ModelsScreen />, { mocks: [catalogueMock(catalogueData(), { delay: 1000 })] });

    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('prices every model per 1M tokens and names the endpoint serving it', async () => {
    renderWithApollo(<ModelsScreen />, { mocks: [catalogueMock(catalogueData())] });

    const row = within(await screen.findByRole('table', { name: 'Model catalogue' })).getByRole('row', {
      name: /Llama 3\.3 70B Instruct/,
    });
    expect(within(row).getByText('meta/llama-3.3-70b-instruct:tdx')).toBeInTheDocument();
    expect(within(row).getByText('llama-33-70b.tee.swarm.cloud')).toBeInTheDocument();
    expect(within(row).getByText('128K')).toBeInTheDocument();
    expect(within(row).getByText('$0.28')).toBeInTheDocument();
    expect(within(row).getByText('$0.42')).toBeInTheDocument();
  });

  it('carries the endpoint’s publication state, not a per-model one', async () => {
    renderWithApollo(<ModelsScreen />, { mocks: [catalogueMock(catalogueData())] });

    expect(
      await screen.findByRole('button', { name: 'Evidence for llama-33-70b.tee.swarm.cloud: Published' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Evidence for qwen25-72b.tee.swarm.cloud: Not published' }),
    ).toBeInTheDocument();
  });

  it('opens the same evidence modal the Overview opens', async () => {
    const user = userEvent.setup();
    renderWithApollo(<ModelsScreen />, { mocks: [catalogueMock(catalogueData())] });

    await user.click(
      await screen.findByRole('button', { name: 'Evidence for llama-33-70b.tee.swarm.cloud: Published' }),
    );

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Evidence published');
    expect(within(dialog).getByRole('button', { name: 'Copy evidence JWS' })).toBeEnabled();
  });

  it('filters on name, slug and TEE from one box', async () => {
    const user = userEvent.setup();
    renderWithApollo(<ModelsScreen />, { mocks: [catalogueMock(catalogueData())] });

    await user.type(await screen.findByRole('searchbox', { name: 'Filter models' }), 'qwen');

    await waitFor(() => expect(screen.queryByText('Llama 3.3 70B Instruct')).not.toBeInTheDocument());
    expect(screen.getByText('Qwen2.5 72B Instruct')).toBeInTheDocument();
    expect(screen.getByText(/1 of 2 models/)).toBeInTheDocument();
  });

  it('narrows the catalogue to one TEE', async () => {
    const user = userEvent.setup();
    renderWithApollo(<ModelsScreen />, { mocks: [catalogueMock(catalogueData())] });

    await user.click(await screen.findByRole('tab', { name: 'AMD SEV-SNP' }));

    await waitFor(() => expect(screen.queryByText('Llama 3.3 70B Instruct')).not.toBeInTheDocument());
    expect(screen.getByText('Qwen2.5 72B Instruct')).toBeInTheDocument();
  });

  it('says so when a filter matches nothing', async () => {
    const user = userEvent.setup();
    renderWithApollo(<ModelsScreen />, { mocks: [catalogueMock(catalogueData())] });

    await user.type(await screen.findByRole('searchbox', { name: 'Filter models' }), 'nothing-like-this');

    expect(await screen.findByText('No model matches this filter')).toBeInTheDocument();
  });

  it('says so when the router serves no models at all', async () => {
    renderWithApollo(<ModelsScreen />, { mocks: [catalogueMock({ models: [] })] });

    expect(await screen.findByText('No models are served yet')).toBeInTheDocument();
  });

  it('offers a retry when the catalogue cannot be loaded', async () => {
    renderWithApollo(<ModelsScreen />, {
      mocks: [{ request: { query: MODEL_CATALOGUE_QUERY }, error: new Error('network down') }],
    });

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

/**
 * External models on the Models page (SUP-227, ADR-008 §7).
 *
 * The property these cases exist for is the one a screenshot cannot show: the two
 * attestation vocabularies appear in the same column and never in the same cell,
 * and neither row type is ever rendered with the other's words.
 */
describe('ModelsScreen, external models', () => {
  function mixed(upstreamOverrides: Parameters<typeof externalModel>[0] = {}) {
    return catalogueMock(catalogueData({ models: [...catalogueData().models, externalModel(upstreamOverrides)] }));
  }

  function externalRow() {
    return within(screen.getByRole('table', { name: 'Model catalogue' })).getByRole('row', {
      name: /Llama 3\.3 70B \(partner\)/,
    });
  }

  it('shows no "External" tag on any row — the serving topology is not the user’s concern', async () => {
    renderWithApollo(<ModelsScreen />, { mocks: [mixed()] });
    await screen.findByRole('table', { name: 'Model catalogue' });

    // The row is still distinguishable by its attestation cell, which carries
    // the external vocabulary; an origin tag beside the name told a user where
    // the weights live, which is the admin section's business (SUP-255).
    expect(screen.queryByText('External', { exact: true })).not.toBeInTheDocument();
    expect(within(externalRow()).getByText('Verified by this router')).toBeInTheDocument();
  });

  it('carries the external vocabulary, and the own-endpoint vocabulary carries on beside it', async () => {
    renderWithApollo(<ModelsScreen />, { mocks: [mixed()] });

    expect(
      await screen.findByRole('button', {
        name: 'Attestation of llama-33-70b.partner.example: Verified by this router',
      }),
    ).toBeInTheDocument();
    // Same column, same table, different vocabulary — and neither row borrows
    // the other's words (ADR-008 §1).
    expect(
      screen.getByRole('button', { name: 'Evidence for llama-33-70b.tee.swarm.cloud: Published' }),
    ).toBeInTheDocument();
  });

  it('never renders an own-endpoint evidence badge for an external row', async () => {
    renderWithApollo(<ModelsScreen />, { mocks: [mixed()] });
    await screen.findByRole('table', { name: 'Model catalogue' });

    const row = externalRow();
    for (const word of ['Published', 'Stale', 'Not published']) {
      expect(within(row).queryByText(word)).not.toBeInTheDocument();
    }
  });

  it('explains what the verdict is and what it is not, when the badge is opened', async () => {
    const user = userEvent.setup();
    renderWithApollo(<ModelsScreen />, { mocks: [mixed()] });

    await user.click(
      await screen.findByRole('button', {
        name: 'Attestation of llama-33-70b.partner.example: Verified by this router',
      }),
    );

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('This router verified this upstream');
    // The two things that make the verdict readable: whose verdict it is, and
    // that it covers the deployment its operator approved, not only the cloud.
    expect(dialog).toHaveTextContent(/not by you/);
    expect(dialog).toHaveTextContent(/the one its operator approved/);
    expect(within(dialog).getByText('partner-cloud')).toBeInTheDocument();
  });

  it('shows a denied upstream as denied by this router', async () => {
    renderWithApollo(<ModelsScreen />, {
      mocks: [
        mixed({
          available: false,
          externalUpstream: verifiedUpstream({
            status: 'DENIED_BY_THIS_ROUTER',
            measurementSeen: null,
            evidenceDigestSeen: null,
            evidenceDigestSeenHex: null,
          }),
        }),
      ],
    });

    expect(
      await screen.findByRole('button', {
        name: 'Attestation of llama-33-70b.partner.example: Denied by this router',
      }),
    ).toBeInTheDocument();
  });

  it('shows an anonymous reader availability and no verdict at all (ruling 3)', async () => {
    // What the API hands a caller with no session: the model, the price, and
    // `available` — no hostname, no status, no measurement.
    renderWithApollo(<ModelsScreen />, { mocks: [mixed({ externalUpstream: null, available: false })] });
    await screen.findByRole('table', { name: 'Model catalogue' });

    const row = externalRow();
    expect(within(row).getByText('Unavailable')).toBeInTheDocument();
    expect(within(row).queryByRole('button')).not.toBeInTheDocument();
    expect(row).not.toHaveTextContent('partner.example');
  });

  it('leaves the TEE cell and filter alone: an external row declares no label', async () => {
    const user = userEvent.setup();
    renderWithApollo(<ModelsScreen />, { mocks: [mixed()] });
    await screen.findByRole('table', { name: 'Model catalogue' });

    expect(within(externalRow()).getAllByText('—').length).toBeGreaterThan(0);

    // Narrowing to a TEE hides the external rows, which is the filter being
    // honest rather than losing them: it narrows on a declaration about this
    // deployment's hardware.
    await user.click(screen.getByRole('tab', { name: 'AMD SEV-SNP' }));
    await waitFor(() => expect(screen.queryByText('Llama 3.3 70B (partner)')).not.toBeInTheDocument());
  });

  it('finds an external model by the upstream hostname a reader can see', async () => {
    const user = userEvent.setup();
    renderWithApollo(<ModelsScreen />, { mocks: [mixed()] });

    await user.type(await screen.findByRole('searchbox', { name: 'Filter models' }), 'partner.example');

    await waitFor(() => expect(screen.queryByText('Llama 3.3 70B Instruct')).not.toBeInTheDocument());
    expect(screen.getByText('Llama 3.3 70B (partner)')).toBeInTheDocument();
  });

  it('counts the external models apart in the footer', async () => {
    renderWithApollo(<ModelsScreen />, { mocks: [mixed()] });

    expect(
      await screen.findByText(/2 models served from 2 endpoints, and 1 from external endpoints\./),
    ).toBeInTheDocument();
  });

  it('claims no endpoints when every model is external', async () => {
    // A single total would imply one source. With no built-ins there is no
    // endpoint count worth printing.
    renderWithApollo(<ModelsScreen />, { mocks: [catalogueMock(catalogueData({ models: [externalModel()] }))] });

    expect(await screen.findByText(/1 model served from external endpoints\./)).toBeInTheDocument();
  });
});
