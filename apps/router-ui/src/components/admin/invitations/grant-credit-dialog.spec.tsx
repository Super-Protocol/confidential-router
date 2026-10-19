import type { MockLink } from '@apollo/client/testing';
import { configure, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithApollo } from '../../../test-utils';
import { GrantCreditDialog, type GrantCreditTarget } from './grant-credit-dialog';
import { GRANT_CREDIT } from './operations';

/**
 * The operator's credit dialog (SUP-406): what it sends for each movement, what
 * it refuses before the round trip, and that the API's refusal reaches the
 * operator verbatim — a `billing.allowCreditDebits` message is the only way the
 * console can learn that setting.
 *
 * Since SUP-398 it also carries the `requestId` that makes a retry a replay, so
 * the id is stubbed here: the mock link matches variables exactly, and the tests
 * about retrying are tests about that value staying put.
 */

configure({ asyncUtilTimeout: 5_000 });

const TARGET: GrantCreditTarget = {
  email: 'tester@example.com',
  workspaceId: 'ws-tester',
  balanceMicros: '40000000',
};

const REQUEST_ID = '11111111-2222-4333-8444-555555555555';
const REASON = 'Internal tester top-up';

beforeEach(() => {
  vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(REQUEST_ID);
});

function grantMock(
  input: Record<string, unknown>,
  result: Partial<Record<string, unknown>> | { message: string },
): MockLink.MockedResponse {
  const variables = {
    input: { workspaceId: TARGET.workspaceId, kind: 'GRANT', note: REASON, requestId: REQUEST_ID, ...input },
  };
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
          note: REASON,
          replayed: false,
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

/** The two fields every movement needs: an amount and a reason. */
async function fill(amount: string, reason = REASON) {
  await type('Amount (USD)', amount);
  await type('Reason', reason);
}

async function pick(movement: string) {
  await userEvent.click(screen.getByRole('combobox', { name: 'Movement' }));
  await userEvent.click(await screen.findByRole('option', { name: movement }));
}

describe('GrantCreditDialog', () => {
  it('shows what the account holds today, so the operator is not guessing', async () => {
    renderDialog();

    expect(await screen.findByText(/They hold \$40\.00 today/)).toBeInTheDocument();
  });

  it('grants the typed amount as a positive GRANT and reports the new balance', async () => {
    renderDialog([grantMock({ amountMicros: '100000000' }, {})]);

    await fill('100');
    await userEvent.click(screen.getByRole('button', { name: 'Grant credit' }));

    expect(await screen.findByTestId('grant-credit-done')).toHaveTextContent(
      '$100 added to tester@example.com. Their balance is now $140.00.',
    );
  });

  it('sends cents as cents', async () => {
    renderDialog([grantMock({ amountMicros: '2500000' }, { amountMicros: '2500000', balanceMicros: '42500000' })]);

    await fill('2.50');
    await userEvent.click(screen.getByRole('button', { name: 'Grant credit' }));

    expect(await screen.findByTestId('grant-credit-done')).toHaveTextContent('$2.50 added');
  });

  it('records a removal as a negative ADJUSTMENT carrying the reason', async () => {
    renderDialog([
      grantMock(
        { amountMicros: '-10000000', kind: 'ADJUSTMENT', note: 'Duplicate grant' },
        { kind: 'ADJUSTMENT', amountMicros: '-10000000', balanceMicros: '30000000', note: 'Duplicate grant' },
      ),
    ]);

    await pick('Correction — remove credit');
    await fill('10', 'Duplicate grant');
    await userEvent.click(screen.getByRole('button', { name: 'Correction — remove credit' }));

    expect(await screen.findByTestId('grant-credit-done')).toHaveTextContent(
      '$10 taken from tester@example.com. Their balance is now $30.00.',
    );
  });

  it('refuses a grant with no reason, before asking the server', async () => {
    renderDialog();

    await type('Amount (USD)', '100');
    await userEvent.click(screen.getByRole('button', { name: 'Grant credit' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Say why this credit is being added.');
  });

  it('refuses a removal with no reason, before asking the server', async () => {
    renderDialog();

    await pick('Correction — remove credit');
    await type('Amount (USD)', '10');
    await userEvent.click(screen.getByRole('button', { name: 'Correction — remove credit' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Say why the credit is being taken away.');
  });

  it('refuses a removal larger than the balance, before asking the server', async () => {
    renderDialog();

    await pick('Correction — remove credit');
    await fill('41', 'Clawback');
    await userEvent.click(screen.getByRole('button', { name: 'Correction — remove credit' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('More than the $40 on this account');
  });

  it('refuses a zero or a non-amount', async () => {
    renderDialog();

    await fill('0');
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

    await pick('Correction — remove credit');
    await fill('10', 'Clawback');
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
    await fill('250', 'Tester top-up');
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
    expect(screen.getByLabelText('Reason')).toHaveValue('');
  });

  it('grants once when the button is double-clicked', async () => {
    renderDialog([grantMock({ amountMicros: '100000000' }, {})]);

    await fill('100');
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

/**
 * The retry path (SUP-398).
 *
 * A 504 over a row that was in fact written leaves the form filled, the button
 * enabled and the operator about to press it again. The id minted when the
 * dialog opened has to survive that, and the second answer has to read as "this
 * was already recorded" rather than as a second success.
 */
describe('retrying a submission', () => {
  it('sends the same requestId, and says the entry was already recorded', async () => {
    renderDialog([
      grantMock({ amountMicros: '100000000' }, { message: 'Gateway timeout' }),
      grantMock({ amountMicros: '100000000' }, { replayed: true, balanceMicros: '140000000' }),
    ]);

    await fill('100');
    await userEvent.click(screen.getByRole('button', { name: 'Grant credit' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Gateway timeout'));

    // The form is still filled and the button still live — the operator presses
    // it again, which is exactly the path that used to double-credit.
    await userEvent.click(screen.getByRole('button', { name: 'Grant credit' }));

    expect(await screen.findByText('Already recorded')).toBeInTheDocument();
    expect(screen.getByTestId('grant-credit-done')).toHaveTextContent(
      'This request was already recorded, so nothing was written a second time.',
    );
    expect(screen.getByTestId('grant-credit-done')).toHaveTextContent('balance stands at $140.00');
  });

  it('mints a new requestId for the next account, so it is not read as a replay', async () => {
    const second = '99999999-8888-4777-8666-555555555555';
    vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce(REQUEST_ID)
      .mockReturnValueOnce(second as `${string}-${string}-${string}-${string}-${string}`);
    const onOpenChange = vi.fn();
    const other = { email: 'other@example.com', workspaceId: 'ws-other', balanceMicros: '0' };
    const { rerender } = renderWithApollo(<GrantCreditDialog target={TARGET} onOpenChange={onOpenChange} />, {
      mocks: [
        {
          request: {
            query: GRANT_CREDIT,
            variables: {
              input: {
                workspaceId: other.workspaceId,
                kind: 'GRANT',
                note: REASON,
                requestId: second,
                amountMicros: '100000000',
              },
            },
          },
          result: {
            data: {
              grantCredit: {
                __typename: 'CreditGrant',
                creditTransactionId: 'tx-2',
                workspaceId: other.workspaceId,
                accountEmail: null,
                kind: 'GRANT',
                amountMicros: '100000000',
                balanceMicros: '100000000',
                note: REASON,
                replayed: false,
              },
            },
          },
        },
      ],
    });

    rerender(<GrantCreditDialog target={other} onOpenChange={onOpenChange} />);
    await screen.findByText('Credit other@example.com');

    await fill('100');
    await userEvent.click(screen.getByRole('button', { name: 'Grant credit' }));

    // Only the second id has a mock, so matching at all is the assertion.
    expect(await screen.findByTestId('grant-credit-done')).toHaveTextContent('$100 added to other@example.com');
  });
});
