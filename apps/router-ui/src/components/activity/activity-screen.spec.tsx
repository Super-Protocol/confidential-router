import type { MockLink } from '@apollo/client/testing';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { renderWithSession, sessionMock } from '../../test-utils';
import { ACTIVITY_QUERY, ACTIVITY_USAGE_BY_MODEL_QUERY, ActivityScreen } from './activity-screen';

// `SessionProvider` reaches for the app router to bounce an expired session.
vi.mock('next/navigation', () => ({
  usePathname: () => '/activity',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
}));

/**
 * The screen pins `now` from the wall clock, so a mock cannot be keyed on a
 * literal `from`/`to`. It is keyed on the *width* of the window instead, which
 * is the only thing the range picker actually changes.
 */
function windowHours(variables: Record<string, unknown>): number {
  return Math.round((Date.parse(variables.to as string) - Date.parse(variables.from as string)) / 3_600_000);
}

function summary(overrides: Record<string, unknown> = {}) {
  return {
    spendMicros: '1234500',
    requests: 842,
    promptTokens: 640_000,
    completionTokens: 160_000,
    coveredRequests: 800,
    evidenceCoverage: 0.95,
    avgTimeToFirstTokenMs: 312,
    avgTokensPerSecond: 48.23,
    ...overrides,
  };
}

function point(bucket: string, requests: number) {
  return {
    bucket,
    spendMicros: `${requests * 1000}`,
    requests,
    promptTokens: requests * 10,
    completionTokens: requests * 4,
    evidenceCoverage: 1,
  };
}

const TOP_KEYS = [
  {
    apiKeyId: 'key-1',
    name: 'agents-prod',
    prefix: 'sk-tee-v1-4f',
    requests: 700,
    promptTokens: 500_000,
    completionTokens: 98_000,
    spendMicros: '1000000',
  },
  {
    apiKeyId: 'key-2',
    name: 'eval-harness',
    prefix: 'sk-tee-v1-b3',
    requests: 142,
    promptTokens: 140_000,
    completionTokens: 42_000,
    spendMicros: '234500',
  },
];

const USAGE_BY_MODEL = [
  {
    modelId: 'meta/llama-3.3-70b-instruct:tdx',
    name: 'Llama 3.3 70B Instruct',
    requests: 700,
    promptTokens: 500_000,
    completionTokens: 98_000,
    spendMicros: '1000000',
    evidenceCoverage: 1,
  },
  {
    modelId: 'qwen/qwen2.5-72b-instruct:snp',
    name: 'Qwen2.5 72B Instruct',
    requests: 142,
    promptTokens: 140_000,
    completionTokens: 42_000,
    spendMicros: '234500',
    evidenceCoverage: 0.5,
  },
];

function activityMock(hours: number, data: Record<string, unknown>): MockLink.MockedResponse {
  return {
    request: {
      query: ACTIVITY_QUERY,
      variables: (variables) => windowHours(variables) === hours,
    },
    result: {
      data: {
        activitySeries: [point('2026-08-31T10:00:00.000Z', 400), point('2026-08-31T11:00:00.000Z', 442)],
        topKeys: TOP_KEYS,
        ...data,
      },
    },
    maxUsageCount: Number.POSITIVE_INFINITY,
  };
}

function usageMock(models = USAGE_BY_MODEL): MockLink.MockedResponse {
  return {
    request: { query: ACTIVITY_USAGE_BY_MODEL_QUERY, variables: () => true },
    result: { data: { usageByModel: models } },
    maxUsageCount: Number.POSITIVE_INFINITY,
  };
}

function defaultMocks(): MockLink.MockedResponse[] {
  return [
    sessionMock(),
    activityMock(24, { activitySummary: summary() }),
    activityMock(24 * 7, { activitySummary: summary({ spendMicros: '45670000', requests: 11_000 }) }),
    usageMock(),
  ];
}

describe('ActivityScreen', () => {
  it('shows every tile for the default 24-hour window', async () => {
    renderWithSession(<ActivityScreen />, { mocks: defaultMocks() });

    expect(await screen.findByText('$1.23')).toBeInTheDocument();
    expect(screen.getByText('842')).toBeInTheDocument();
    expect(screen.getByText('800K')).toBeInTheDocument();
    expect(screen.getByText('312 ms')).toBeInTheDocument();
    expect(screen.getByText('95%')).toBeInTheDocument();
    expect(screen.getByText('800 of 842 served with published evidence')).toBeInTheDocument();
  });

  it('re-queries and repaints the tiles when the range changes', async () => {
    renderWithSession(<ActivityScreen />, { mocks: defaultMocks() });

    await screen.findByText('$1.23');
    await userEvent.click(screen.getByRole('button', { name: 'Past 7 days' }));

    expect(await screen.findByText('$45.67')).toBeInTheDocument();
    expect(screen.getByText('11K')).toBeInTheDocument();
    expect(screen.queryByText('$1.23')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Past 7 days' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('gives the time-to-first-token tile no sparkline, because the series carries no latency', async () => {
    renderWithSession(<ActivityScreen />, { mocks: defaultMocks() });

    await screen.findByText('$1.23');

    expect(screen.getByRole('img', { name: 'Total spend trend' })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Time to first token trend' })).not.toBeInTheDocument();
  });

  it('says a period reported no first-token time instead of printing a zero', async () => {
    renderWithSession(<ActivityScreen />, {
      mocks: [
        sessionMock(),
        activityMock(24, {
          activitySummary: summary({ avgTimeToFirstTokenMs: null, avgTokensPerSecond: null }),
        }),
        usageMock(),
      ],
    });

    expect(await screen.findByText('—')).toBeInTheDocument();
    expect(screen.getByText('Average across the period')).toBeInTheDocument();
  });

  it('ranks the top keys by spend', async () => {
    renderWithSession(<ActivityScreen />, { mocks: defaultMocks() });

    const list = within(await screen.findByRole('list', { name: 'Top API keys by spend' }));
    const entries = list.getAllByRole('listitem');

    expect(entries[0]).toHaveTextContent('agents-prod');
    expect(entries[0]).toHaveTextContent('$1.00');
    expect(entries[1]).toHaveTextContent('eval-harness');
  });

  it('breaks 30 days down by model as stacked input and output tokens', async () => {
    renderWithSession(<ActivityScreen />, { mocks: defaultMocks() });

    const chart = await screen.findByRole('table', { name: 'Tokens by model over the last 30 days' });

    expect(within(chart).getByRole('rowheader', { name: 'Llama 3.3 70B Instruct' })).toBeInTheDocument();
    expect(within(chart).getByRole('columnheader', { name: 'Input tokens' })).toBeInTheDocument();
    expect(within(chart).getByRole('columnheader', { name: 'Output tokens' })).toBeInTheDocument();
  });

  it('offers a retry when the activity query fails', async () => {
    renderWithSession(<ActivityScreen />, {
      mocks: [sessionMock(), { ...activityMock(24, {}), result: { errors: [{ message: 'boom' }] } }, usageMock()],
    });

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('keeps the tiles when only the 30-day model breakdown fails', async () => {
    renderWithSession(<ActivityScreen />, {
      mocks: [
        sessionMock(),
        activityMock(24, { activitySummary: summary() }),
        { ...usageMock(), result: { errors: [{ message: 'boom' }] } },
      ],
    });

    expect(await screen.findByText('$1.23')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Usage by model could not be loaded.'));
  });
});
