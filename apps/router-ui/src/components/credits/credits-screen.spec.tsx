import type { MockLink } from '@apollo/client/testing';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithSession, TEST_WORKSPACES } from '../../test-utils';
import { typedSessionMock } from '../typed-session';
import { CreditsScreen } from './credits-screen';
import { CREATE_CHECKOUT, CREDITS_QUERY, SET_AUTO_TOP_UP } from './operations';

const search = vi.hoisted(() => ({ current: new URLSearchParams() }));
const replace = vi.hoisted(() => vi.fn());
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => search.current,
}));

vi.mock('sonner', () => ({ toast: toasts }));

const WORKSPACE_ID = TEST_WORKSPACES[0].id;

const BALANCE = {
  __typename: 'CreditBalance' as const,
  workspaceId: WORKSPACE_ID,
  balanceMicros: '170650000',
  spendable: true,
  minTopUpMicros: '5000000',
  autoTopUp: {
    __typename: 'AutoTopUp' as const,
    enabled: false,
    available: true,
    thresholdMicros: null,
    amountMicros: null,
    lastChargedAt: null,
  },
};

function transaction(overrides: Record<string, unknown> = {}) {
  return {
    __typename: 'CreditTransaction' as const,
    id: 'txn-1',
    createdAt: '2026-08-30T12:00:00.000Z',
    kind: 'PURCHASE' as const,
    amountMicros: '25000000',
    reference: 'pi_123',
    description: 'Credit purchase of $25.00 https://pay.stripe.com/receipts/abc',
    ...overrides,
  };
}

function ledger(nodes: ReturnType<typeof transaction>[], hasNextPage = false) {
  return {
    __typename: 'CreditTransactionConnection' as const,
    totalCount: nodes.length,
    pageInfo: { __typename: 'PageInfo' as const, hasNextPage, endCursor: nodes.at(-1)?.id ?? null },
    edges: nodes.map((node) => ({ __typename: 'CreditTransactionEdge' as const, cursor: node.id, node })),
  };
}

function creditsMock(
  balance = BALANCE,
  nodes: ReturnType<typeof transaction>[] = [transaction()],
  hasNextPage = false,
): MockLink.MockedResponse {
  return {
    request: { query: CREDITS_QUERY, variables: { workspaceId: WORKSPACE_ID, first: 20 } },
    result: { data: { creditBalance: balance, creditTransactions: ledger(nodes, hasNextPage) } },
    maxUsageCount: Number.POSITIVE_INFINITY,
  };
}

function render(mocks: MockLink.MockedResponse[]) {
  return renderWithSession(<CreditsScreen />, { mocks: [typedSessionMock(), ...mocks] });
}

beforeEach(() => {
  search.current = new URLSearchParams();
  replace.mockReset();
  toasts.success.mockReset();
  toasts.error.mockReset();
  toasts.info.mockReset();
});

describe('CreditsScreen', () => {
  it('shows the balance and the ledger', async () => {
    render([creditsMock()]);

    expect(await screen.findByTestId('credit-balance')).toHaveTextContent('$170.65');
    const row = screen.getByRole('row', { name: /Credit purchase/ });
    expect(within(row).getByText('+$25.00')).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: /Receipt/ })).toHaveAttribute(
      'href',
      'https://pay.stripe.com/receipts/abc',
    );
  });

  it('warns that /v1 is refusing requests once the balance is unspendable', async () => {
    render([creditsMock({ ...BALANCE, balanceMicros: '-1200000', spendable: false })]);

    expect(await screen.findByTestId('credit-balance')).toHaveTextContent('-$1.20');
    expect(screen.getByRole('status')).toHaveTextContent('402');
  });

  it('rejects a top-up below the minimum without calling the API', async () => {
    render([creditsMock()]);

    await userEvent.clear(await screen.findByLabelText('Amount (USD)'));
    await userEvent.type(screen.getByLabelText('Amount (USD)'), '1');
    await userEvent.click(screen.getByRole('button', { name: 'Add credits' }));

    expect(await screen.findByText('The minimum top-up is $5.00.')).toBeInTheDocument();
  });

  it('sends the browser to the checkout URL the API returns', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });

    render([
      creditsMock(),
      {
        request: {
          query: CREATE_CHECKOUT,
          variables: { input: { workspaceId: WORKSPACE_ID, amountMicros: '50000000' } },
        },
        result: {
          data: {
            createCheckout: {
              __typename: 'CheckoutSession',
              url: 'https://checkout.stripe.com/c/pay/cs_1',
              ref: 'cs_1',
            },
          },
        },
      },
    ]);

    await userEvent.click(await screen.findByRole('button', { name: '$50' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add credits' }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://checkout.stripe.com/c/pay/cs_1'));
    vi.unstubAllGlobals();
  });

  it('saves an auto top-up threshold and shows what the server stored', async () => {
    const saved = {
      ...BALANCE,
      autoTopUp: {
        ...BALANCE.autoTopUp,
        enabled: true,
        thresholdMicros: '20000000',
        amountMicros: '25000000',
        lastChargedAt: '2026-08-20T00:00:00.000Z',
      },
    };

    render([
      creditsMock(),
      {
        request: {
          query: SET_AUTO_TOP_UP,
          variables: {
            input: {
              workspaceId: WORKSPACE_ID,
              settings: { enabled: true, thresholdMicros: '20000000', amountMicros: '25000000' },
            },
          },
        },
        result: { data: { setAutoTopUp: saved } },
      },
    ]);

    await userEvent.click(await screen.findByLabelText('Enable automatic top-up'));
    await userEvent.type(screen.getByLabelText('When balance falls below (USD)'), '20');
    await userEvent.type(screen.getByLabelText('Buy this much (USD)'), '25');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('Automatic top-up updated.'));
    // `CreditBalance` has no id to normalise on, so this only holds because the
    // mutation writes its result into the screen's query: the card is reading
    // what the server stored, not what was typed.
    await waitFor(() => expect(screen.getByText(/Last charged Aug 20, 2026/)).toBeInTheDocument());
    expect(screen.getByLabelText('When balance falls below (USD)')).toHaveValue('20');
  });

  it('refuses to save an enabled auto top-up with an empty threshold', async () => {
    render([creditsMock()]);

    await userEvent.click(await screen.findByLabelText('Enable automatic top-up'));
    await userEvent.type(screen.getByLabelText('Buy this much (USD)'), '25');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Set the balance that triggers a top-up.')).toBeInTheDocument();
    expect(toasts.success).not.toHaveBeenCalled();
  });

  it('lets a member read the ledger but not spend the workspace card', async () => {
    const member = TEST_WORKSPACES[1];
    renderWithSession(<CreditsScreen />, {
      mocks: [
        typedSessionMock([member]),
        {
          ...creditsMock(),
          request: { query: CREDITS_QUERY, variables: { workspaceId: member.id, first: 20 } },
        },
      ],
    });

    expect(await screen.findByTestId('credit-balance')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add credits' })).toBeDisabled();
    expect(screen.getByLabelText('Enable automatic top-up')).toBeDisabled();
    expect(screen.getByRole('row', { name: /Credit purchase/ })).toBeInTheDocument();
  });

  it('confirms a completed checkout and clears the parameter so a reload does not repeat it', async () => {
    search.current = new URLSearchParams('topup=success');
    render([creditsMock()]);

    await waitFor(() => expect(toasts.success).toHaveBeenCalled());
    expect(replace).toHaveBeenCalledWith('/credits');
  });

  it('says nothing was charged when the viewer backed out of checkout', async () => {
    search.current = new URLSearchParams('topup=cancelled');
    render([creditsMock()]);

    await waitFor(() => expect(toasts.info).toHaveBeenCalledWith('Checkout cancelled. Nothing was charged.'));
  });

  it('appends the next page of the ledger instead of replacing it', async () => {
    const first = transaction({ id: 'txn-1', description: 'Credit purchase of $25.00' });
    const second = transaction({ id: 'txn-2', kind: 'USAGE', amountMicros: '-1200000', description: null });

    render([
      creditsMock(BALANCE, [first], true),
      {
        request: { query: CREDITS_QUERY, variables: { workspaceId: WORKSPACE_ID, first: 20, after: 'txn-1' } },
        result: { data: { creditBalance: BALANCE, creditTransactions: ledger([second]) } },
      },
    ]);

    await userEvent.click(await screen.findByRole('button', { name: 'Load more' }));

    expect(await screen.findByText('-$1.20')).toBeInTheDocument();
    expect(screen.getByText('+$25.00')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('offers a way back when the balance cannot be read', async () => {
    renderWithSession(<CreditsScreen />, {
      mocks: [
        typedSessionMock(),
        {
          request: { query: CREDITS_QUERY, variables: { workspaceId: WORKSPACE_ID, first: 20 } },
          error: new Error('network down'),
        },
      ],
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('The balance could not be loaded');
  });
});
