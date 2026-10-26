import type { MockLink } from '@apollo/client/testing';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { isAdminMock, renderWithSession, sessionMock } from '../../../test-utils';
import { InvitationsScreen } from './invitations-screen';
import {
  ADMIN_API_KEY_POPULATION_QUERY,
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

/** An account row, with its credential census (SUP-454). */
function signUp(
  email: string,
  values: Partial<{
    userId: string;
    origin: string;
    inviteCode: string | null;
    campaign: string | null;
    apiKeys: { total: number; live: number; lastUsedAt: string | null };
  }> = {},
) {
  const apiKeys = values.apiKeys ?? { total: 0, live: 0, lastUsedAt: null };
  return {
    __typename: 'AdminSignUp' as const,
    userId: values.userId ?? email,
    email,
    createdAt: '2026-10-09T09:00:00.000Z',
    origin: values.origin ?? 'OPEN',
    inviteCodeId: values.inviteCode ? 'code-1' : null,
    inviteCode: values.inviteCode ?? null,
    campaign: values.campaign ?? null,
    redeemedAt: values.inviteCode ? '2026-10-09T09:00:00.000Z' : null,
    apiKeys: { __typename: 'AccountApiKeys' as const, ...apiKeys },
  };
}

function signUpsMock(
  nodes: ReturnType<typeof signUp>[],
  variables: Record<string, unknown> = {},
): MockLink.MockedResponse {
  return {
    request: {
      query: ADMIN_SIGN_UPS_QUERY,
      variables: { origin: null, holdsLiveApiKey: null, offset: 0, limit: 50, ...variables },
    },
    result: {
      data: { adminSignUps: { __typename: 'AdminSignUpPage', totalCount: nodes.length, nodes } },
    },
    maxUsageCount: Number.POSITIVE_INFINITY,
  };
}

function populationMock(
  values: Partial<{
    keys: number;
    liveKeys: number;
    accountsHoldingLiveKey: number;
    liveKeysWithoutAccount: number;
  }> = {},
): MockLink.MockedResponse {
  return {
    request: { query: ADMIN_API_KEY_POPULATION_QUERY, variables: {} },
    result: {
      data: {
        adminApiKeyPopulation: {
          __typename: 'ApiKeyPopulation',
          keys: 0,
          liveKeys: 0,
          accountsHoldingLiveKey: 0,
          liveKeysWithoutAccount: 0,
          ...values,
        },
      },
    },
    maxUsageCount: Number.POSITIVE_INFINITY,
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
                carried: false,
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

  it('exports what the filters show: every code by default, the chosen campaign and status after', async () => {
    renderScreen({
      mocks: [
        codesMock([code()]),
        {
          request: {
            query: ADMIN_INVITE_CODES_QUERY,
            variables: { campaign: null, status: 'REDEEMED', offset: 0, limit: 50 },
          },
          result: { data: { adminInviteCodes: { __typename: 'AdminInviteCodePage', totalCount: 0, nodes: [] } } },
        },
      ],
    });

    await userEvent.click(await screen.findByRole('tab', { name: 'Codes' }));
    const link = await screen.findByRole('link', { name: 'Export CSV' });
    expect(new URL(link.getAttribute('href') ?? '').pathname).toBe('/admin/invite-codes/export.csv');
    expect(new URL(link.getAttribute('href') ?? '').search).toBe('');

    await userEvent.click(screen.getByRole('combobox', { name: 'Status' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Redeemed' }));

    await waitFor(() =>
      expect(new URL(screen.getByRole('link', { name: 'Export CSV' }).getAttribute('href') ?? '').search).toBe(
        '?status=redeemed',
      ),
    );
  });

  it('marks a redemption carried over by an import, linked or not', async () => {
    renderScreen({
      mocks: [
        codesMock([
          code({
            status: 'REDEEMED',
            redemptionCount: 1,
            issuedByEmail: null,
            redeemers: [
              {
                __typename: 'InviteCodeRedeemer',
                userId: null,
                email: 'earlier@example.com',
                redeemedAt: '2026-10-01T09:00:00.000Z',
                carried: true,
              },
            ],
          }),
        ]),
      ],
    });

    await userEvent.click(await screen.findByRole('tab', { name: 'Codes' }));
    const row = await screen.findByTestId('invite-code-row-code-1');

    expect(row).toHaveTextContent('earlier@example.com');
    expect(row).toHaveTextContent('imported');
    expect(within(row).getByTitle(/no account with this address here/)).toBeInTheDocument();
  });

  it('imports a CSV in two steps: the dry-run report first, the write only on confirm', async () => {
    const report = {
      sha256: 'f'.repeat(64),
      applied: false,
      ok: true,
      totalRows: 6,
      toCreate: { active: 3, redeemed: 1, expired: 0, withdrawn: 1 },
      createCount: 5,
      campaigns: 2,
      redemptionsLinked: 0,
      redemptionsUnlinked: 1,
      duplicateCount: 1,
      duplicates: [{ row: 4, code: 'WXYZ-••••-••••', reason: 'already_present' }],
      errorCount: 0,
      errors: [],
    };
    const calls: { url: URL; init: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL, init: RequestInit) => {
        calls.push({ url: new URL(url), init });
        const applied = new URL(url).searchParams.get('apply') === 'true';
        return new Response(JSON.stringify({ ...report, applied }), { status: 200 });
      }),
    );
    renderScreen({ mocks: [codesMock([code()])] });

    await userEvent.click(await screen.findByRole('tab', { name: 'Codes' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Import CSV' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Import' })).toBeDisabled();

    const file = new File(['code,url\r\n'], 'invite-codes-all.csv', { type: 'text/csv' });
    await userEvent.upload(within(dialog).getByLabelText('Codes CSV'), file);

    expect(await within(dialog).findByTestId('import-report')).toHaveTextContent('6 rows in the file');
    expect(within(dialog).getByTestId('import-count-unredeemed')).toHaveTextContent('3');
    expect(within(dialog).getByTestId('import-count-redeemed')).toHaveTextContent('1');
    expect(within(dialog).getByTestId('import-count-withdrawn')).toHaveTextContent('1');
    expect(within(dialog).getByRole('list', { name: 'Skipped duplicates' })).toHaveTextContent(
      'Row 4 · WXYZ-••••-•••• · already on this deployment',
    );
    // Only the dry run so far: nothing asked the API to write.
    expect(calls).toHaveLength(1);
    expect(calls[0].url.pathname).toBe('/admin/invite-codes/import');
    expect(calls[0].url.search).toBe('');
    expect(calls[0].init).toMatchObject({ method: 'POST', credentials: 'include', body: 'code,url\r\n' });
    expect(calls[0].init.headers).toEqual({ 'Content-Type': 'text/csv' });

    await userEvent.click(within(dialog).getByRole('button', { name: 'Import 5 codes' }));

    expect(await within(dialog).findByRole('heading', { name: 'Invitation codes imported' })).toBeInTheDocument();
    expect(calls).toHaveLength(2);
    expect(calls[1].url.searchParams.get('apply')).toBe('true');
    expect(calls[1].url.searchParams.get('expect')).toBe(report.sha256);
    vi.unstubAllGlobals();
  });

  it('shows malformed rows by number and will not import the file', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              sha256: 'a'.repeat(64),
              applied: false,
              ok: false,
              totalRows: 2,
              toCreate: { active: 1, redeemed: 0, expired: 0, withdrawn: 0 },
              createCount: 1,
              campaigns: 1,
              redemptionsLinked: 0,
              redemptionsUnlinked: 0,
              duplicateCount: 0,
              duplicates: [],
              errorCount: 1,
              errors: [{ row: 3, message: '“code” is not an invitation code.' }],
            }),
            { status: 200 },
          ),
      ),
    );
    renderScreen({ mocks: [codesMock([code()])] });

    await userEvent.click(await screen.findByRole('tab', { name: 'Codes' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Import CSV' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.upload(
      within(dialog).getByLabelText('Codes CSV'),
      new File(['x'], 'bad.csv', { type: 'text/csv' }),
    );

    expect(await within(dialog).findByRole('list', { name: 'Malformed rows' })).toHaveTextContent(
      'Row 3: “code” is not an invitation code.',
    );
    expect(within(dialog).getByRole('button', { name: 'Import' })).toBeDisabled();
    vi.unstubAllGlobals();
  });

  it('says why a file that is not a codes export was refused', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ message: 'This is not an invitation codes export.' }), { status: 400 }),
      ),
    );
    renderScreen({ mocks: [codesMock([code()])] });

    await userEvent.click(await screen.findByRole('tab', { name: 'Codes' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Import CSV' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.upload(
      within(dialog).getByLabelText('Codes CSV'),
      new File(['a,b'], 'x.csv', { type: 'text/csv' }),
    );

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('This is not an invitation codes export.');
    expect(within(dialog).queryByTestId('import-report')).not.toBeInTheDocument();
    vi.unstubAllGlobals();
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
        signUpsMock([
          signUp('dev@example.com', { userId: 'u-2', origin: 'INVITE', inviteCode: CODE, campaign: 'launch' }),
          signUp('admin@example.com', { userId: 'u-1', origin: 'BOOTSTRAP' }),
        ]),
        populationMock(),
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

/**
 * The credential census on the account list (SUP-454) — the only supported answer
 * to "which accounts here hold a live key", because `apiKeys(workspaceId)`
 * refuses an operator who is not a member of the workspace asked about.
 */
describe('the Invitations section, on who holds an API key', () => {
  it('counts each account’s keys and when one was last used, and nothing more', async () => {
    renderScreen({
      mocks: [
        signUpsMock([
          signUp('holder@example.com', {
            apiKeys: { total: 3, live: 2, lastUsedAt: '2026-10-18T09:00:00.000Z' },
          }),
          signUp('keyless@example.com'),
        ]),
        populationMock({ keys: 3, liveKeys: 2, accountsHoldingLiveKey: 1 }),
      ],
    });

    await userEvent.click(await screen.findByRole('tab', { name: 'Sign-ups' }));
    const table = await screen.findByRole('table', { name: 'Sign-ups' });

    const holder = within(table).getByRole('row', { name: /holder@example\.com/ });
    expect(holder).toHaveTextContent('2 live of 3');
    expect(holder).toHaveTextContent('Oct 18, 2026');
    // The census is counts only; a prefix would be key material on a screen that
    // gets screenshotted.
    expect(holder).not.toHaveTextContent('sk-tee');
    expect(within(table).getByRole('row', { name: /keyless@example\.com/ })).not.toHaveTextContent('live');
  });

  it('says deployment-wide how many accounts a key-affecting change would cut off', async () => {
    renderScreen({
      mocks: [
        signUpsMock([signUp('holder@example.com', { apiKeys: { total: 1, live: 1, lastUsedAt: null } })]),
        populationMock({ keys: 9, liveKeys: 7, accountsHoldingLiveKey: 5 }),
      ],
    });

    await userEvent.click(await screen.findByRole('tab', { name: 'Sign-ups' }));

    expect(await screen.findByTestId('api-key-population')).toHaveTextContent(
      '5 accounts hold a live API key — 7 live of 9 ever issued.',
    );
  });

  it('names the live keys no account list can account for', async () => {
    renderScreen({
      mocks: [
        signUpsMock([signUp('holder@example.com', { apiKeys: { total: 1, live: 1, lastUsedAt: null } })]),
        populationMock({ keys: 3, liveKeys: 3, accountsHoldingLiveKey: 1, liveKeysWithoutAccount: 2 }),
      ],
    });

    await userEvent.click(await screen.findByRole('tab', { name: 'Sign-ups' }));

    expect(await screen.findByTestId('api-key-population')).toHaveTextContent(
      '2 live keys are held by no account this deployment can name',
    );
  });

  it('narrows the list — and its total — to the accounts holding a live key', async () => {
    renderScreen({
      mocks: [
        signUpsMock([
          signUp('holder@example.com', { apiKeys: { total: 1, live: 1, lastUsedAt: null } }),
          signUp('keyless@example.com'),
        ]),
        signUpsMock([signUp('holder@example.com', { apiKeys: { total: 1, live: 1, lastUsedAt: null } })], {
          holdsLiveApiKey: true,
        }),
        populationMock({ keys: 1, liveKeys: 1, accountsHoldingLiveKey: 1 }),
      ],
    });

    await userEvent.click(await screen.findByRole('tab', { name: 'Sign-ups' }));
    await screen.findByRole('row', { name: /keyless@example\.com/ });

    await userEvent.click(screen.getByLabelText('API keys'));
    await userEvent.click(await screen.findByRole('option', { name: 'Holds a live key' }));

    // The pager, not a row: `holder` is in both lists, so only the total tells
    // the filtered render apart from the one before it.
    expect(await screen.findByText('1–1 of 1')).toBeInTheDocument();
    expect(screen.queryByRole('row', { name: /keyless@example\.com/ })).not.toBeInTheDocument();
    expect(screen.getByRole('row', { name: /holder@example\.com/ })).toBeInTheDocument();
  });

  it('says the filters matched nothing, and never that every account holds a key', async () => {
    renderScreen({
      mocks: [
        signUpsMock([signUp('keyless@example.com')]),
        signUpsMock([], { holdsLiveApiKey: true }),
        populationMock(),
      ],
    });

    await userEvent.click(await screen.findByRole('tab', { name: 'Sign-ups' }));
    await screen.findByRole('row', { name: /keyless@example\.com/ });

    await userEvent.click(screen.getByLabelText('API keys'));
    await userEvent.click(await screen.findByRole('option', { name: 'Holds a live key' }));

    expect(await screen.findByText('No accounts match these filters')).toBeInTheDocument();
  });
});
