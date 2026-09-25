import type { MockLink } from '@apollo/client/testing';
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithSession, sessionMock, TEST_VIEWER, TEST_WORKSPACES } from '../../test-utils';
import { NEXT_STEP_QUERY, NextStepCard } from './next-step-card';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => '/',
}));

const WORKSPACE_ID = TEST_WORKSPACES[0].id;

function keysMock(keys: Array<{ id: string; revokedAt: string | null }>): MockLink.MockedResponse {
  return {
    request: { query: NEXT_STEP_QUERY, variables: { workspaceId: WORKSPACE_ID } },
    result: {
      data: { apiKeys: keys.map((key) => ({ __typename: 'ApiKey', ...key })) },
    },
    maxUsageCount: Number.POSITIVE_INFINITY,
  };
}

/** The session, with this workspace's balance set to whatever the case is about. */
function withBalance(balanceMicros: string): MockLink.MockedResponse {
  return sessionMock({
    me: {
      ...TEST_VIEWER,
      workspaces: [{ ...TEST_WORKSPACES[0], balanceMicros }, ...TEST_WORKSPACES.slice(1)],
    },
  });
}

describe('NextStepCard', () => {
  it('names the balance and the one step left, with the snippet already filled in', async () => {
    renderWithSession(<NextStepCard />, { mocks: [withBalance('100000000'), keysMock([])] });

    const card = await screen.findByTestId('next-step-card');
    expect(card).toHaveTextContent('You have $100 to spend. One step to go.');
    expect(screen.getByRole('link', { name: /Create a key/ })).toHaveAttribute('href', '/keys');
    // The drop-in snippet, not a link to documentation about one.
    expect(card).toHaveTextContent('from openai import OpenAI');
    expect(card).toHaveTextContent('base_url=');
  });

  it('disappears once the workspace has a key', async () => {
    const { container } = renderWithSession(<NextStepCard />, {
      mocks: [withBalance('100000000'), keysMock([{ id: 'key-1', revokedAt: null }])],
    });

    await waitFor(() => expect(container.querySelector('[data-testid="next-step-card"]')).toBeNull());
  });

  it('comes back when every key has been revoked', async () => {
    renderWithSession(<NextStepCard />, {
      mocks: [withBalance('100000000'), keysMock([{ id: 'key-1', revokedAt: '2026-09-01T00:00:00.000Z' }])],
    });

    // A revoked key cannot authenticate anything, so the account is back where it
    // started and the nudge is still the right one.
    expect(await screen.findByTestId('next-step-card')).toBeInTheDocument();
  });

  it('stays away from a workspace with no credit, which cannot send a request anyway', async () => {
    const { container } = renderWithSession(<NextStepCard />, { mocks: [withBalance('0'), keysMock([])] });

    // Telling it to create a key and try would be sending it into a 402.
    await waitFor(() => expect(container.querySelector('[data-testid="next-step-card"]')).toBeNull());
  });
});
