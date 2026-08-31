import type { MockLink } from '@apollo/client/testing';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { renderWithSession, sessionMock } from '../../test-utils';
import { GENERATION_LOG_QUERY, LOG_FILTER_OPTIONS_QUERY, LogsScreen } from './logs-screen';

// `SessionProvider` reaches for the app router to bounce an expired session.
vi.mock('next/navigation', () => ({
  usePathname: () => '/logs',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
}));

type Variables = Record<string, any>;

function generation(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    createdAt: '2026-08-31T11:42:07.000Z',
    modelId: 'meta/llama-3.3-70b-instruct:tdx',
    modelName: 'Llama 3.3 70B Instruct',
    apiKeyId: 'key-1',
    apiKeyName: 'agents-prod',
    promptTokens: 1234,
    completionTokens: 567,
    costMicros: '2100',
    latencyMs: 4200,
    timeToFirstTokenMs: 312,
    tokensPerSecond: 48.23,
    status: 'OK',
    errorCode: null,
    ...overrides,
  };
}

function connection(nodes: ReturnType<typeof generation>[], { hasNextPage = false, totalCount = nodes.length } = {}) {
  return {
    totalCount,
    pageInfo: { hasNextPage, endCursor: hasNextPage ? `cursor-${nodes.length}` : null },
    edges: nodes.map((node) => ({ cursor: `cursor-${node.id}`, node })),
  };
}

function logMock(
  match: (variables: Variables) => boolean,
  generations: ReturnType<typeof connection>,
): MockLink.MockedResponse {
  return {
    request: { query: GENERATION_LOG_QUERY, variables: match },
    result: { data: { generations } },
    maxUsageCount: Number.POSITIVE_INFINITY,
  };
}

const optionsMock: MockLink.MockedResponse = {
  request: { query: LOG_FILTER_OPTIONS_QUERY, variables: () => true },
  result: {
    data: {
      models: [
        { id: 'meta/llama-3.3-70b-instruct:tdx', name: 'Llama 3.3 70B Instruct' },
        { id: 'qwen/qwen2.5-72b-instruct:snp', name: 'Qwen2.5 72B Instruct' },
      ],
      apiKeys: [{ id: 'key-1', name: 'agents-prod', prefix: 'sk-tee-v1-4f' }],
    },
  },
  maxUsageCount: Number.POSITIVE_INFINITY,
};

/**
 * The screen's opening query: default sort, no narrowing, first page. `MockLink`
 * serves the first mock whose matcher accepts the variables, so this has to
 * reject everything a control could change — otherwise it answers the query the
 * test just triggered as well as the one before it.
 */
const unfiltered = (variables: Variables) =>
  variables.filter?.statuses === undefined &&
  variables.filter?.modelIds === undefined &&
  variables.filter?.apiKeyIds === undefined &&
  variables.sort?.direction === 'DESC' &&
  variables.sort?.field === 'CREATED_AT' &&
  variables.after === undefined;

describe('LogsScreen', () => {
  it('renders one row per metered generation, and says prompts are never stored', async () => {
    renderWithSession(<LogsScreen />, {
      mocks: [sessionMock(), optionsMock, logMock(unfiltered, connection([generation('gen-1')]))],
    });

    const table = await screen.findByRole('table');
    expect(within(table).getByText('Llama 3.3 70B Instruct')).toBeInTheDocument();
    expect(within(table).getByText('agents-prod')).toBeInTheDocument();
    expect(within(table).getByText('1,234')).toBeInTheDocument();
    expect(within(table).getByText('48.2 tok/s')).toBeInTheDocument();
    expect(within(table).getByText('312 ms')).toBeInTheDocument();

    expect(screen.getByText(/Prompt content is never stored/)).toBeInTheDocument();
  });

  it('shows no evidence column — a per-request verdict is not a fact the router has', async () => {
    renderWithSession(<LogsScreen />, {
      mocks: [sessionMock(), optionsMock, logMock(unfiltered, connection([generation('gen-1')]))],
    });

    const table = await screen.findByRole('table');
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((header) => header.textContent);

    expect(headers).toEqual(['Time', 'Model', 'API key', 'Input', 'Output', 'Cost', 'Speed', 'TTFT', 'Status']);
  });

  it('re-queries when the range changes', async () => {
    renderWithSession(<LogsScreen />, {
      mocks: [
        sessionMock(),
        optionsMock,
        logMock(
          (variables) =>
            Math.round((Date.parse(variables.filter.to) - Date.parse(variables.filter.from)) / 3_600_000) === 24,
          connection([generation('gen-1')]),
        ),
        logMock(
          (variables) =>
            Math.round((Date.parse(variables.filter.to) - Date.parse(variables.filter.from)) / 3_600_000) === 24 * 30,
          connection([generation('gen-old', { modelName: 'Qwen2.5 72B Instruct' })]),
        ),
      ],
    });

    await screen.findByText('Llama 3.3 70B Instruct');
    await userEvent.click(screen.getByRole('button', { name: 'Past 30 days' }));

    expect(await screen.findByText('Qwen2.5 72B Instruct')).toBeInTheDocument();
    expect(screen.queryByText('Llama 3.3 70B Instruct')).not.toBeInTheDocument();
  });

  it('narrows the query to the chosen status', async () => {
    renderWithSession(<LogsScreen />, {
      mocks: [
        sessionMock(),
        optionsMock,
        logMock(unfiltered, connection([generation('gen-1')])),
        logMock(
          (variables) => variables.filter?.statuses?.[0] === 'ERROR',
          connection([generation('gen-err', { status: 'ERROR', errorCode: 'upstream_timeout' })]),
        ),
      ],
    });

    await screen.findByText('Llama 3.3 70B Instruct');
    await userEvent.click(screen.getByRole('combobox', { name: 'Status' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Error' }));

    expect(await screen.findByText('upstream_timeout')).toBeInTheDocument();
  });

  it('flips the sort direction without losing the sort field', async () => {
    renderWithSession(<LogsScreen />, {
      mocks: [
        sessionMock(),
        optionsMock,
        logMock(unfiltered, connection([generation('gen-1')])),
        logMock(
          (variables) => variables.sort?.direction === 'ASC',
          connection([generation('gen-oldest', { modelName: 'Qwen2.5 72B Instruct' })]),
        ),
      ],
    });

    await screen.findByText('Llama 3.3 70B Instruct');
    await userEvent.click(screen.getByRole('button', { name: 'Sort descending' }));

    expect(await screen.findByText('Qwen2.5 72B Instruct')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sort ascending' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('appends the next page instead of replacing the first', async () => {
    renderWithSession(<LogsScreen />, {
      mocks: [
        sessionMock(),
        optionsMock,
        logMock(unfiltered, connection([generation('gen-1')], { hasNextPage: true, totalCount: 2 })),
        logMock(
          (variables) => variables.after === 'cursor-1',
          connection([generation('gen-2', { modelName: 'Qwen2.5 72B Instruct' })], { totalCount: 2 }),
        ),
      ],
    });

    await screen.findByText('Llama 3.3 70B Instruct');
    expect(screen.getByText('Showing 1 of 2')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));

    expect(await screen.findByText('Qwen2.5 72B Instruct')).toBeInTheDocument();
    expect(screen.getByText('Llama 3.3 70B Instruct')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Showing 2 of 2')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('offers no "load more" when the server says there is no next page', async () => {
    renderWithSession(<LogsScreen />, {
      mocks: [sessionMock(), optionsMock, logMock(unfiltered, connection([generation('gen-1')]))],
    });

    await screen.findByText('Llama 3.3 70B Instruct');
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('points the CSV export at router-api with the filters currently applied', async () => {
    renderWithSession(<LogsScreen />, {
      mocks: [
        sessionMock(),
        optionsMock,
        logMock(unfiltered, connection([generation('gen-1')])),
        logMock((variables) => variables.filter?.statuses?.[0] === 'ABORTED', connection([])),
      ],
    });

    await screen.findByText('Llama 3.3 70B Instruct');
    await userEvent.click(screen.getByRole('combobox', { name: 'Status' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Aborted' }));

    await waitFor(() => {
      const href = screen.getByRole('link', { name: /Export CSV/ }).getAttribute('href') as string;
      const url = new URL(href);
      expect(url.pathname).toBe('/activity/generations.csv');
      expect(url.searchParams.get('workspaceId')).toBe('ws-1');
      expect(url.searchParams.get('status')).toBe('aborted');
    });
  });

  it('says nothing matched rather than showing an empty table', async () => {
    renderWithSession(<LogsScreen />, {
      mocks: [sessionMock(), optionsMock, logMock(unfiltered, connection([]))],
    });

    expect(await screen.findByText('No generations match these filters')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('offers a retry when the log query fails', async () => {
    renderWithSession(<LogsScreen />, {
      mocks: [
        sessionMock(),
        optionsMock,
        { ...logMock(unfiltered, connection([])), result: { errors: [{ message: 'boom' }] } },
      ],
    });

    expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
