import type { MockLink } from '@apollo/client/testing';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { lastUtcDays } from '../../lib/date-range';
import { renderWithSession, TEST_VIEWER, TEST_WORKSPACES } from '../../test-utils';
import { typedSessionMock } from '../typed-session';
import { PROFILE_QUERY, UPDATE_PROFILE } from './operations';
import { HEATMAP_DAYS, SPEND_DAYS } from './profile-data';
import { ProfileScreen } from './profile-screen';

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast: toasts }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }), usePathname: () => '/profile' }));

const WORKSPACE_ID = TEST_WORKSPACES[0].id;
const DAY_MS = 86_400_000;

/** The screen asks for a window ending today, so the fixtures follow the clock. */
const RANGE = lastUtcDays(SPEND_DAYS);
const HEATMAP_FROM = lastUtcDays(HEATMAP_DAYS).from;

/** The heatmap window's traffic: own-endpoint only, so the graph is the story. */
const HEATMAP_TOTALS = {
  __typename: 'ActivitySummary' as const,
  requests: 30,
  coveredRequests: 30,
  coverableRequests: 30,
  evidenceCoverage: 1,
};

/** `days` ago, as the UTC day the API returns. */
function daysAgo(days: number): string {
  return new Date(Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`) - days * DAY_MS).toISOString();
}

const ME = {
  __typename: 'User' as const,
  id: TEST_VIEWER.id,
  name: 'Dev Eloper',
  email: TEST_VIEWER.email,
  avatarUrl: null,
  createdAt: '2026-04-02T08:00:00.000Z',
};

function series() {
  return Array.from({ length: SPEND_DAYS }, (_, index) => ({
    __typename: 'ActivityPoint' as const,
    bucket: daysAgo(SPEND_DAYS - 1 - index),
    spendMicros: String((index + 1) * 1_000_000),
    requests: index + 1,
    promptTokens: 1000,
    completionTokens: 500,
  }));
}

function profileMock(overrides: Record<string, unknown> = {}): MockLink.MockedResponse {
  return {
    request: {
      query: PROFILE_QUERY,
      variables: { workspaceId: WORKSPACE_ID, ...RANGE, heatmapFrom: HEATMAP_FROM, heatmapDays: HEATMAP_DAYS },
    },
    result: {
      data: {
        me: ME,
        activitySeries: series(),
        usageByModel: [
          {
            __typename: 'ModelUsage',
            modelId: 'meta/llama-3.3-70b-instruct:tdx',
            name: 'Llama 3.3 70B Instruct',
            spendMicros: '21000000',
            requests: 21,
          },
          {
            __typename: 'ModelUsage',
            modelId: 'qwen/qwen2.5-72b-instruct:tdx',
            name: 'Qwen2.5 72B Instruct',
            spendMicros: '7000000',
            requests: 9,
          },
        ],
        signedResponseDays: [daysAgo(2), daysAgo(1), daysAgo(0)],
        heatmapTotals: HEATMAP_TOTALS,
        ...overrides,
      },
    },
    maxUsageCount: Number.POSITIVE_INFINITY,
  };
}

beforeEach(() => {
  toasts.success.mockReset();
  toasts.error.mockReset();
});

describe('ProfileScreen', () => {
  it('shows the account, the week it spent, and the models it went on', async () => {
    renderWithSession(<ProfileScreen />, { mocks: [typedSessionMock(), profileMock()] });

    expect(await screen.findByText('Dev Eloper')).toBeInTheDocument();
    expect(screen.getByText('Member since Apr 2, 2026')).toBeInTheDocument();
    // 1 + 2 + … + 7 dollars over the week.
    expect(screen.getByText('$28.00')).toBeInTheDocument();
    expect(screen.getByText('Llama 3.3 70B Instruct')).toBeInTheDocument();
    expect(screen.getByText('$21.00')).toBeInTheDocument();
  });

  it('draws the spend strip with a screen-reader table, not colour alone', async () => {
    renderWithSession(<ProfileScreen />, { mocks: [typedSessionMock(), profileMock()] });

    // The three summary tiles are the Overview's, so the chart's label is the
    // one `StatTile` derives from the tile's own name.
    expect(await screen.findByRole('group', { name: 'Spend' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Spend per day' })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Spend per day' })).toBeInTheDocument();
  });

  it('counts the days evidence was published, and the longest run of them', async () => {
    renderWithSession(<ProfileScreen />, { mocks: [typedSessionMock(), profileMock()] });

    expect(await screen.findByText('3 days')).toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: `Days with published evidence over the last ${HEATMAP_DAYS} days` }),
    ).toBeInTheDocument();
  });

  it('says why the heatmap is empty when every generation went to an external endpoint', async () => {
    // SUP-421 on a second screen: this account's traffic is attested — by this
    // router's own verdict — but none of it has a bundle *this platform*
    // published, so the graph can only draw six months of grey under a legend
    // reading "No evidence".
    renderWithSession(<ProfileScreen />, {
      mocks: [
        typedSessionMock(),
        profileMock({
          signedResponseDays: [],
          heatmapTotals: {
            ...HEATMAP_TOTALS,
            requests: 34,
            coveredRequests: 0,
            coverableRequests: 0,
            evidenceCoverage: null,
          },
        }),
      ],
    });

    expect(await screen.findByText(/coverage does not apply here/)).toBeInTheDocument();
    expect(screen.getByText(/all 34 generations were served by external endpoints/)).toBeInTheDocument();
    expect(screen.getByText(/verified by this router/)).toBeInTheDocument();
    // Not an empty graph with a zero streak beside it.
    expect(
      screen.queryByRole('img', { name: `Days with published evidence over the last ${HEATMAP_DAYS} days` }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Days covered')).not.toBeInTheDocument();
    expect(screen.queryByText('0 days')).not.toBeInTheDocument();
  });

  it('still draws the graph for a workspace that served nothing at all', async () => {
    // The other cause of an empty graph, and it needs no explanation: there is
    // no traffic to have gone anywhere.
    renderWithSession(<ProfileScreen />, {
      mocks: [
        typedSessionMock(),
        profileMock({
          signedResponseDays: [],
          heatmapTotals: {
            ...HEATMAP_TOTALS,
            requests: 0,
            coveredRequests: 0,
            coverableRequests: 0,
            evidenceCoverage: null,
          },
        }),
      ],
    });

    expect(await screen.findByText('0 days')).toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: `Days with published evidence over the last ${HEATMAP_DAYS} days` }),
    ).toBeInTheDocument();
  });

  it('describes the heatmap as publication, and disclaims the verdict (ADR-002)', async () => {
    renderWithSession(<ProfileScreen />, { mocks: [typedSessionMock(), profileMock()] });

    expect(await screen.findByText(/fresh evidence bundle published/)).toBeInTheDocument();
    expect(screen.getByText(/this router never learns it/)).toBeInTheDocument();
    // No square, badge or heading ever says a response was verified.
    expect(screen.queryByText(/^verified$/i)).not.toBeInTheDocument();
  });

  it('saves a new display name', async () => {
    renderWithSession(<ProfileScreen />, {
      mocks: [
        typedSessionMock(),
        profileMock(),
        {
          request: { query: UPDATE_PROFILE, variables: { input: { name: 'Denis' } } },
          result: { data: { updateProfile: { ...ME, name: 'Denis' } } },
        },
      ],
    });

    const input = await screen.findByLabelText('Display name');
    await userEvent.clear(input);
    await userEvent.type(input, 'Denis');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('Profile updated.'));
  });

  it('refuses a blank name instead of sending one', async () => {
    renderWithSession(<ProfileScreen />, { mocks: [typedSessionMock(), profileMock()] });

    await userEvent.clear(await screen.findByLabelText('Display name'));
    await userEvent.type(screen.getByLabelText('Display name'), '   ');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(/blank name is not a name/)).toBeInTheDocument();
    expect(toasts.success).not.toHaveBeenCalled();
  });

  it('keeps Save inert until the name actually changes', async () => {
    renderWithSession(<ProfileScreen />, { mocks: [typedSessionMock(), profileMock()] });

    await screen.findByLabelText('Display name');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('says so when a quiet period returned no models', async () => {
    renderWithSession(<ProfileScreen />, { mocks: [typedSessionMock(), profileMock({ usageByModel: [] })] });

    expect(await screen.findByText('Nothing was routed in this period.')).toBeInTheDocument();
  });

  it('offers a way back when the screen cannot be loaded', async () => {
    renderWithSession(<ProfileScreen />, {
      mocks: [
        typedSessionMock(),
        {
          request: {
            query: PROFILE_QUERY,
            variables: { workspaceId: WORKSPACE_ID, ...RANGE, heatmapFrom: HEATMAP_FROM, heatmapDays: HEATMAP_DAYS },
          },
          error: new Error('network down'),
        },
      ],
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('The profile could not be loaded');
  });
});
