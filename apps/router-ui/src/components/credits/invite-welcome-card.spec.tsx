import type { MockLink } from '@apollo/client/testing';
import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { INVITE_STORAGE_KEY } from '../../lib/invite';
import { renderWithApollo } from '../../test-utils';
import { INVITE_GRANT_STATUS_QUERY } from '../invites/operations';
import { InviteWelcomeCard } from './invite-welcome-card';

const CODE = 'ABCDEFGHJKLM';

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal('location', { ...window.location, search: '' });
});

function statusMock(
  result: { reason?: string | null; grant?: Record<string, unknown> | null },
  code: string | null = CODE,
): MockLink.MockedResponse {
  return {
    request: { query: INVITE_GRANT_STATUS_QUERY, variables: { code } },
    result: {
      data: {
        inviteGrantStatus: {
          __typename: 'InviteGrantStatus',
          reason: result.reason ?? null,
          grant: result.grant
            ? {
                __typename: 'InviteGrant',
                creditTransactionId: 'tx-1',
                grantMicros: '100000000',
                campaign: 'launch-2026-10-devs',
                redeemedAt: '2026-09-25T12:00:00.000Z',
                ...result.grant,
              }
            : null,
        },
      },
    },
    maxUsageCount: Number.POSITIVE_INFINITY,
  };
}

describe('InviteWelcomeCard', () => {
  it('confirms the credit and points at the ledger entry that holds it', async () => {
    window.localStorage.setItem(INVITE_STORAGE_KEY, CODE);
    renderWithApollo(<InviteWelcomeCard />, { mocks: [statusMock({ grant: {} })] });

    const card = await screen.findByTestId('invite-granted');
    expect(card).toHaveTextContent('$100 in credits is in your account.');
    expect(card).toHaveTextContent('launch-2026-10-devs');
  });

  it('drops the stored code once it has an answer', async () => {
    window.localStorage.setItem(INVITE_STORAGE_KEY, CODE);
    renderWithApollo(<InviteWelcomeCard />, { mocks: [statusMock({ grant: {} })] });

    await screen.findByTestId('invite-granted');
    // A spent code left behind would greet the next person to use this browser
    // with someone else's invitation.
    expect(window.localStorage.getItem(INVITE_STORAGE_KEY)).toBeNull();
  });

  /**
   * Every refusal has to say two things: the credit did not arrive, and the
   * account is fine. A registration is never failed over a code (SUP-142), so the
   * viewer is looking at a working console either way.
   */
  it.each([
    ['EXPIRED', /had expired/],
    ['EXHAUSTED', /already been claimed/],
    ['DISABLED', /no longer active/],
    ['NOT_FOUND', /did not recognise/],
    ['ERROR', /Something went wrong/],
  ])('explains a %s code in its own words', async (reason, matcher) => {
    window.localStorage.setItem(INVITE_STORAGE_KEY, CODE);
    renderWithApollo(<InviteWelcomeCard />, { mocks: [statusMock({ reason })] });

    const card = await screen.findByTestId('invite-refused');
    expect(card).toHaveTextContent(matcher);
    expect(card.textContent).toMatch(/account is ready|sort it out|ask us for a new one/);
  });

  it('says both halves when the account already had its credit', async () => {
    window.localStorage.setItem(INVITE_STORAGE_KEY, CODE);
    renderWithApollo(<InviteWelcomeCard />, { mocks: [statusMock({ reason: 'ALREADY_REDEEMED', grant: {} })] });

    // The grant is real and the second code bought nothing; a card that showed
    // only one of the two would be misleading whichever one it picked.
    const card = await screen.findByTestId('invite-granted');
    expect(card).toHaveTextContent('$100 in credits is in your account.');
    expect(card).toHaveTextContent('one per account');
  });

  it('renders nothing for an account that never presented a code', async () => {
    const { container } = renderWithApollo(<InviteWelcomeCard />, { mocks: [statusMock({}, null)] });

    await screen.findByTestId('invite-welcome-loading');
    await waitFor(() => expect(container.querySelector('[data-testid^="invite-"]')).toBeNull());
  });
});
