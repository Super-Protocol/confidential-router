import type { MockLink } from '@apollo/client/testing';
import { configure, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { renderWithApollo } from '../../../test-utils';
import { GrantCreditDialog, type GrantCreditTarget } from './grant-credit-dialog';
import { GRANT_CREDIT } from './operations';

/**
 * The operator's credit dialog (SUP-406): what it sends for each movement, what
 * it refuses before the round trip, and that the API's refusal reaches the
 * operator verbatim — a `billing.allowCreditDebits` message is the only way the
 * console can learn that setting.
 */

configure({ asyncUtilTimeout: 5_000 });

const TARGET: GrantCreditTarget = {
  email: 'tester@example.com',
  workspaceId: 'ws-tester',
  balanceMicros: '40000000',
};

function grantMock(
  input: Record<string, unknown>,
  result: Partial<Record<string, unknown>> | { message: string },
): MockLink.MockedResponse {
  const variables = { input: { workspaceId: TARGET.workspaceId, kind: 'GRANT', note: null, ...input } };
  if ('message' in result) {
    return { request: { query: GRANT_CREDIT, variables }, result: { errors: [{ message: result.message }] } as never };
  }
  return {
    request: { query: GRANT_CREDIT, variables },
    result: {
      data: {
        grantCredit: {
          __typename: 'CreditGrant',
          creditTransactionId: 'tx-1',
          workspaceId: TARGET.workspaceId,
          accountEmail: null,
          kind: 'GRANT',
          amountMicros: '100000000',
          balanceMicros: '140000000',
          note: null,
          ...result,
        },
      },
    },
  };
}

function renderDialog(mocks: MockLink.MockedResponse[] = [], target: GrantCreditTarget | null = TARGET) {
  const onOpenChange = vi.fn();
  renderWithApollo(<GrantCreditDialog target={target} onOpenChange={onOpenChange} />, { mocks });
  return { onOpenChange };
}

async function type(label: string, value: string) {
  const input = screen.getByLabelText(label);
  await userEvent.clear(input);
  await userEvent.type(input, value);
}

describe('GrantCreditDialog', () => {
  it('shows what the account holds today, so the operator is not guessing', async () => {
    renderDialog();

    expect(await screen.findByText(/They hold \$40\.00 today/)).toBeInTheDocument();
  });

  it('grants the typed amount as a positive GRANT and reports the new balance', async () => {
    renderDialog([grantMock({ amountMicros: '100000000' }, {})]);

    await type('Amount (USD)', '100');
    await userEvent.click(screen.getByRole('button', { name: 'Grant credit' }));

    expect(await screen.findByTestId('grant-credit-done')).toHaveTextContent(
      '$100 added to tester@example.com. Their balance is now $140.00.',
    );
  });

  it('sends cents as cents', async () => {
    renderDialog([grantMock({ amountMicros: '2500000' }, { amountMicros: '2500000', balanceMicros: '42500000' })]);

    await type('Amount (USD)', '2.50');
    await userEvent.click(screen.getByRole('button', { name: 'Grant credit' }));

    expect(await screen.findByTestId('grant-credit-done')).toHaveTextContent('$2.50 added');
  });

  it('records a removal as a negative ADJUSTMENT carrying the note', async () => {
    renderDialog([
      grantMock(
        { amountMicros: '-10000000', kind: 'ADJUSTMENT', note: 'Duplicate grant' },
        { kind: 'ADJUSTMENT', amountMicros: '-10000000', balanceMicros: '30000000', note: 'Duplicate grant' },
      ),
    ]);

    await userEvent.click(screen.getByRole('combobox', { name: 'Movement' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Correction — remove credit' }));
    await type('Amount (USD)', '10');
    await type('Note', 'Duplicate grant');
    await userEvent.click(screen.getByRole('button', { name: 'Correction — remove credit' }));

    expect(await screen.findByTestId('grant-credit-done')).toHaveTextContent(
      '$10 taken from tester@example.com. Their balance is now $30.00.',
    );
  });

  it('refuses a removal with no note, before asking the server', async () => {
    renderDialog();

    await userEvent.click(screen.getByRole('combobox', { name: 'Movement' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Correction — remove credit' }));
    await type('Amount (USD)', '10');
    await userEvent.click(screen.getByRole('button', { name: 'Correction — remove credit' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Say why the credit is being taken away.');
  });

  it('refuses a removal larger than the balance, before asking the server', async () => {
    renderDialog();

    await userEvent.click(screen.getByRole('combobox', { name: 'Movement' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Correction — remove credit' }));
    await type('Amount (USD)', '41');
    await type('Note', 'Clawback');
    await userEvent.click(screen.getByRole('button', { name: 'Correction — remove credit' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('More than the $40 on this account');
  });

  it('refuses a zero or a non-amount', async () => {
    renderDialog();

    await type('Amount (USD)', '0');
    await userEvent.click(screen.getByRole('button', { name: 'Grant credit' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('A dollar amount above $0.');
  });

  it('shows the API’s refusal as it is — which is how the operator learns about allowCreditDebits', async () => {
    renderDialog([
      grantMock(
        { amountMicros: '-10000000', kind: 'ADJUSTMENT', note: 'Clawback' },
        {
          message: 'This deployment does not allow credit to be removed. Set billing.allowCreditDebits to enable it.',
        },
      ),
    ]);

    await userEvent.click(screen.getByRole('combobox', { name: 'Movement' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Correction — remove credit' }));
    await type('Amount (USD)', '10');
    await type('Note', 'Clawback');
    await userEvent.click(screen.getByRole('button', { name: 'Correction — remove credit' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Set billing.allowCreditDebits to enable it.'),
    );
  });

  it('starts clean on the next account, rather than showing the last grant’s result', async () => {
    const onOpenChange = vi.fn();
    const { rerender } = renderWithApollo(<GrantCreditDialog target={TARGET} onOpenChange={onOpenChange} />, {
      mocks: [grantMock({ amountMicros: '250000000', note: 'Tester top-up' }, {})],
    });

    // Not the initial $100, so the field being back at $100 below is the reset
    // rather than a coincidence.
    await type('Amount (USD)', '250');
    await type('Note (optional)', 'Tester top-up');
    await userEvent.click(screen.getByRole('button', { name: 'Grant credit' }));
    expect(await screen.findByTestId('grant-credit-done')).toBeInTheDocument();

    // Done closes it, the way an operator does.
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);

    rerender(
      <GrantCreditDialog
        target={{ email: 'other@example.com', workspaceId: 'ws-other', balanceMicros: '0' }}
        onOpenChange={onOpenChange}
      />,
    );

    expect(await screen.findByText('Credit other@example.com')).toBeInTheDocument();
    expect(screen.queryByTestId('grant-credit-done')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Amount (USD)')).toHaveValue('100');
    expect(screen.getByLabelText('Note (optional)')).toHaveValue('');
  });

  it('grants once when the button is double-clicked — the service keys each call freshly', async () => {
    renderDialog([grantMock({ amountMicros: '100000000' }, {})]);

    await type('Amount (USD)', '100');
    const button = screen.getByRole('button', { name: 'Grant credit' });
    // Two clicks inside one render window: `loading` has not flipped yet.
    await userEvent.dblClick(button);

    expect(await screen.findByTestId('grant-credit-done')).toBeInTheDocument();
    // A second call would have had no mock left and surfaced as a failure.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders nothing while no account is picked', () => {
    renderDialog([], null);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
