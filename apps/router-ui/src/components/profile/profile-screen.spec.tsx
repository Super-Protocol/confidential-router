import type { MockLink } from '@apollo/client/testing';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { lastUtcDays } from '../../lib/date-range';
import { renderWithSession, TEST_VIEWER, TEST_WORKSPACES } from '../../test-utils';
import { typedSessionMock } from '../typed-session';
import { PROFILE_QUERY, SET_PASSWORD, UPDATE_PROFILE } from './operations';
import { HEATMAP_DAYS, SPEND_DAYS } from './profile-data';
import { ProfileScreen } from './profile-screen';

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast: toasts }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }), usePathname: () => '/profile' }));

const WORKSPACE_ID = TEST_WORKSPACES[0].id;
const DAY_MS = 86_400_000;

/** The screen asks for a window ending today, so the fixtures follow the clock. */
const RANGE = lastUtcDays(SPEND_DAYS);

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
  hasPassword: true,
};

/** The account the bootstrap token creates: no credential at all (SUP-267). */
const NO_PASSWORD = { ...ME, hasPassword: false };

const SIGN_IN_OPTIONS = {
  __typename: 'SignInOptions' as const,
  password: true,
  passwordMinLength: 12,
  passwordReset: false,
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
      variables: { workspaceId: WORKSPACE_ID, ...RANGE, heatmapDays: HEATMAP_DAYS },
    },
    result: {
      data: {
        me: ME,
        signInOptions: SIGN_IN_OPTIONS,
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
            variables: { workspaceId: WORKSPACE_ID, ...RANGE, heatmapDays: HEATMAP_DAYS },
          },
          error: new Error('network down'),
        },
      ],
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('The profile could not be loaded');
  });

  describe('an account with no password (SUP-267)', () => {
    const PASSWORD = 'correct-horse-battery';

    it('offers to set one, and says why', async () => {
      renderWithSession(<ProfileScreen />, { mocks: [typedSessionMock(), profileMock({ me: NO_PASSWORD })] });

      expect(await screen.findByText('Set a password')).toBeInTheDocument();
      expect(screen.getByText(/this browser session is your only way in/)).toBeInTheDocument();
      expect(screen.getByText(/At least 12 characters/)).toBeInTheDocument();
    });

    it('sets it, and takes the card away once the account has one', async () => {
      renderWithSession(<ProfileScreen />, {
        mocks: [
          typedSessionMock(),
          profileMock({ me: NO_PASSWORD }),
          {
            request: { query: SET_PASSWORD, variables: { input: { password: PASSWORD } } },
            result: { data: { setPassword: ME } },
          },
        ],
      });

      await userEvent.type(await screen.findByLabelText('New password'), PASSWORD);
      await userEvent.type(screen.getByLabelText('Confirm password'), PASSWORD);
      await userEvent.click(screen.getByRole('button', { name: 'Set password' }));

      await waitFor(() => expect(toasts.success).toHaveBeenCalledWith(expect.stringMatching(/^Password set\./)));
      await waitFor(() => expect(screen.queryByText('Set a password')).not.toBeInTheDocument());
    });

    it('keeps the button inert below the deployment’s minimum', async () => {
      renderWithSession(<ProfileScreen />, { mocks: [typedSessionMock(), profileMock({ me: NO_PASSWORD })] });

      await userEvent.type(await screen.findByLabelText('New password'), 'short');
      await userEvent.type(screen.getByLabelText('Confirm password'), 'short');
      expect(screen.getByRole('button', { name: 'Set password' })).toBeDisabled();
    });

    it('refuses two passwords that differ instead of sending either', async () => {
      renderWithSession(<ProfileScreen />, { mocks: [typedSessionMock(), profileMock({ me: NO_PASSWORD })] });

      await userEvent.type(await screen.findByLabelText('New password'), PASSWORD);
      await userEvent.type(screen.getByLabelText('Confirm password'), `${PASSWORD}!`);
      await userEvent.click(screen.getByRole('button', { name: 'Set password' }));

      expect(await screen.findByText('The two passwords do not match.')).toBeInTheDocument();
      expect(toasts.success).not.toHaveBeenCalled();
    });

    it('is not offered on a deployment that does not sign in with passwords', async () => {
      renderWithSession(<ProfileScreen />, {
        mocks: [
          typedSessionMock(),
          profileMock({ me: NO_PASSWORD, signInOptions: { ...SIGN_IN_OPTIONS, password: false } }),
        ],
      });

      await screen.findByText('Dev Eloper');
      expect(screen.queryByText('Set a password')).not.toBeInTheDocument();
    });
  });

  it('offers no password card to an account that already has one', async () => {
    renderWithSession(<ProfileScreen />, { mocks: [typedSessionMock(), profileMock()] });

    await screen.findByText('Dev Eloper');
    expect(screen.queryByText('Set a password')).not.toBeInTheDocument();
  });
});
