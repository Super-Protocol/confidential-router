import type { MockLink } from '@apollo/client/testing';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { ModelCatalogueQuery } from '../../generated/graphql';
import { catalogueData } from '../../test-fixtures';
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
