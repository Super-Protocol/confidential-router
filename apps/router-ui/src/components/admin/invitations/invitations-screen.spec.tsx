import type { MockLink } from '@apollo/client/testing';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { isAdminMock, renderWithSession, sessionMock } from '../../../test-utils';
import { InvitationsScreen } from './invitations-screen';
import {
  ADMIN_INVITE_CODES_QUERY,
  ADMIN_SIGN_UPS_QUERY,
  INVITE_STATISTICS_QUERY,
  ISSUE_INVITE_CODES,
  WITHDRAW_INVITE_CODE,
} from './operations';

vi.mock('next/navigation', () => ({
  usePathname: () => '/admin/invitations',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
}));

vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 5_000 });

const CODE = 'ABCD-EFGH-JKMN';
const URL_OF = (code: string) => `https://router.example/?invite=${code}&utm_campaign=launch`;

function day(date: string, values: Partial<Record<string, number>> = {}) {
  return {
    __typename: 'InviteDay' as const,
    date,
    codesIssued: 0,
    codesRedeemed: 0,
    signUpsInvited: 0,
    signUpsBootstrap: 0,
    signUpsOpen: 0,
    ...values,
  };
}

function statisticsMock(days = 30): MockLink.MockedResponse {
  return {
    request: { query: INVITE_STATISTICS_QUERY, variables: { days } },
    result: {
      data: {
        inviteStatistics: {
          __typename: 'InviteStatistics',
          totals: {
            __typename: 'InviteTotals',
            issued: 51,
            redeemed: 3,
            withdrawn: 1,
            redemptionRate: 3 / 51,
            grantedMicros: '300000000',
            signUps: 5,
          },
          daily: [
            day('2026-10-08', { codesIssued: 51, signUpsBootstrap: 1 }),
            day('2026-10-09', { codesRedeemed: 3, signUpsInvited: 3, signUpsOpen: 1 }),
          ],
          campaigns: [
            {
              __typename: 'InviteCampaignStats',
              campaign: 'launch',
              issued: 51,
              redeemed: 3,
              redemptionRate: 3 / 51,
              activated: 2,
              grantedMicros: '300000000',
            },
          ],
        },
      },
    },
    maxUsageCount: Number.POSITIVE_INFINITY,
  };
}

function code(overrides: Record<string, unknown> = {}) {
  return {
    __typename: 'AdminInviteCode' as const,
    id: 'code-1',
    code: CODE,
    url: URL_OF(CODE),
    campaign: 'launch',
    grantMicros: '100000000',
    maxRedemptions: 1,
    redemptionCount: 0,
    status: 'ACTIVE',
    createdAt: '2026-10-08T10:00:00.000Z',
    expiresAt: null,
    withdrawnAt: null,
    note: null,
    issuedByEmail: 'ops@example.com',
    redeemers: [] as unknown[],
    ...overrides,
  };
}

function codesMock(nodes: unknown[]): MockLink.MockedResponse {
  return {
    request: {
      query: ADMIN_INVITE_CODES_QUERY,
      variables: { campaign: null, status: null, offset: 0, limit: 50 },
    },
    result: { data: { adminInviteCodes: { __typename: 'AdminInviteCodePage', totalCount: nodes.length, nodes } } },
    maxUsageCount: Number.POSITIVE_INFINITY,
  };
}

function renderScreen({ admin = true, mocks = [] }: { admin?: boolean; mocks?: MockLink.MockedResponse[] } = {}) {
  return renderWithSession(<InvitationsScreen />, {
    mocks: [sessionMock(), isAdminMock(admin), statisticsMock(), ...mocks],
  });
}

describe('InvitationsScreen', () => {
  it('tells a member the section is for administrators, with no button to issue anything', async () => {
    renderScreen({ admin: false });

    expect(await screen.findByTestId('invitations-restricted')).toHaveTextContent('Administrators only');
    expect(screen.queryByRole('button', { name: 'Issue codes' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });

  it('opens on the statistics: totals, the three chart groups, and the campaign table', async () => {
    renderScreen();

    expect(await screen.findByRole('group', { name: 'Statistics window' })).toBeInTheDocument();
    expect(await screen.findByText('Sign-ups per day, by origin')).toBeInTheDocument();
    expect(screen.getByText('Codes issued per day')).toBeInTheDocument();
    expect(screen.getByText('Codes redeemed per day')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Sign-ups per day by origin, past 30 days' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Codes redeemed and not redeemed, by campaign' })).toBeInTheDocument();
    // The tile and the campaign row.
    expect(screen.getAllByText('$300')).toHaveLength(2);
    const campaigns = screen.getByRole('table', { name: 'Campaigns' });
    expect(within(campaigns).getByRole('row', { name: /launch/ })).toHaveTextContent('5.8%');
  });

  it('masks codes until asked, and copies or reveals one row at a time', async () => {
    renderScreen({
      mocks: [
        codesMock([
          code({
            status: 'REDEEMED',
            redemptionCount: 1,
            redeemers: [
              {
                __typename: 'InviteCodeRedeemer',
                userId: 'u-1',
                email: 'dev@example.com',
                redeemedAt: '2026-10-09T09:00:00.000Z',
              },
            ],
          }),
        ]),
      ],
    });

    await userEvent.click(await screen.findByRole('tab', { name: 'Codes' }));
    const table = await screen.findByRole('table', { name: 'Invitation codes' });
    const row = within(table).getByTestId('invite-code-row-code-1');

    expect(within(row).getByTestId('invite-code')).toHaveTextContent('ABCD-••••-••••');
    expect(row).not.toHaveTextContent(CODE);
    expect(row).toHaveTextContent('dev@example.com');
    expect(row).toHaveTextContent('Redeemed');
    // Nothing left to withdraw on a spent code.
    expect(within(row).queryByRole('button', { name: /Withdraw/ })).not.toBeInTheDocument();

    await userEvent.click(within(row).getByRole('button', { name: 'Reveal code ABCD-••••-••••' }));
    expect(within(row).getByTestId('invite-code')).toHaveTextContent(CODE);
  });

  it('withdraws an unredeemed code by its id', async () => {
    const withdraw = vi.fn(() => ({
      data: {
        withdrawInviteCode: {
          __typename: 'InviteWithdrawal',
          target: 'invitation code-1',
          matched: 1,
          withdrawn: 1,
          alreadyWithdrawn: 0,
          spent: 0,
        },
      },
    }));
    renderScreen({
      mocks: [
        codesMock([code()]),
        { request: { query: WITHDRAW_INVITE_CODE, variables: { id: 'code-1' } }, result: withdraw },
      ],
    });

    await userEvent.click(await screen.findByRole('tab', { name: 'Codes' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Withdraw code ABCD-••••-••••' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Credit it already granted is not affected');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Withdraw code' }));

    await waitFor(() => expect(withdraw).toHaveBeenCalled());
  });

  it('issues a batch and shows it once, with copy-all and the CSV', async () => {
    const codes = Array.from({ length: 3 }, (_, index) => ({
      __typename: 'IssuedInviteCode' as const,
      id: `new-${index}`,
      code: `NEW${index}-AAAA-BBBB`,
      url: URL_OF(`NEW${index}-AAAA-BBBB`),
    }));
    renderScreen({
      mocks: [
        codesMock([]),
        {
          request: {
            query: ISSUE_INVITE_CODES,
            variables: {
              input: {
                count: 3,
                grantMicros: '25000000',
                campaign: 'launch',
                maxRedemptions: 1,
                expiresAt: null,
                note: null,
              },
            },
          },
          result: {
            data: {
              issueInviteCodes: {
                __typename: 'IssuedInviteCodes',
                campaign: 'launch',
                grantMicros: '25000000',
                expiresAt: null,
                codes,
              },
            },
          },
        },
      ],
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Issue codes' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.clear(within(dialog).getByLabelText('Number of codes'));
    await userEvent.type(within(dialog).getByLabelText('Number of codes'), '3');
    await userEvent.clear(within(dialog).getByLabelText('Credit per code (USD)'));
    await userEvent.type(within(dialog).getByLabelText('Credit per code (USD)'), '25');
    await userEvent.type(within(dialog).getByLabelText('Campaign tag'), 'launch');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Issue codes' }));

    expect(await screen.findByText('3 invitation codes issued')).toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'Issued invitation codes' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(list).toHaveTextContent('NEW0-AAAA-BBBB');
    expect(screen.getByRole('button', { name: 'Copy all' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download CSV' })).toBeInTheDocument();
  });

  it('says what is wrong with the form before asking the API', async () => {
    renderScreen();

    await userEvent.click(await screen.findByRole('button', { name: 'Issue codes' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.clear(within(dialog).getByLabelText('Number of codes'));
    await userEvent.type(within(dialog).getByLabelText('Number of codes'), '5000');
    await userEvent.type(within(dialog).getByLabelText('Campaign tag'), 'Bad Tag');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Issue codes' }));

    expect(await within(dialog).findByText('Between 1 and 1000 codes per batch.')).toBeInTheDocument();
    expect(within(dialog).getByText(/Use a lowercase tag/)).toBeInTheDocument();
  });

  it('lists accounts with how each came to exist', async () => {
    renderScreen({
      mocks: [
        {
          request: { query: ADMIN_SIGN_UPS_QUERY, variables: { origin: null, offset: 0, limit: 50 } },
          result: {
            data: {
              adminSignUps: {
                __typename: 'AdminSignUpPage',
                totalCount: 2,
                nodes: [
                  {
                    __typename: 'AdminSignUp',
                    userId: 'u-2',
                    email: 'dev@example.com',
                    createdAt: '2026-10-09T09:00:00.000Z',
                    origin: 'INVITE',
                    inviteCodeId: 'code-1',
                    inviteCode: CODE,
                    campaign: 'launch',
                    redeemedAt: '2026-10-09T09:00:00.000Z',
                  },
                  {
                    __typename: 'AdminSignUp',
                    userId: 'u-1',
                    email: 'admin@example.com',
                    createdAt: '2026-10-08T09:00:00.000Z',
                    origin: 'BOOTSTRAP',
                    inviteCodeId: null,
                    inviteCode: null,
                    campaign: null,
                    redeemedAt: null,
                  },
                ],
              },
            },
          },
          maxUsageCount: Number.POSITIVE_INFINITY,
        },
      ],
    });

    await userEvent.click(await screen.findByRole('tab', { name: 'Sign-ups' }));
    const table = await screen.findByRole('table', { name: 'Sign-ups' });

    const invited = within(table).getByRole('row', { name: /dev@example\.com/ });
    expect(invited).toHaveTextContent('Invitation');
    expect(invited).toHaveTextContent('ABCD-••••-••••');
    expect(invited).not.toHaveTextContent(CODE);
    expect(within(table).getByRole('row', { name: /admin@example\.com/ })).toHaveTextContent('Bootstrap');
  });
});
