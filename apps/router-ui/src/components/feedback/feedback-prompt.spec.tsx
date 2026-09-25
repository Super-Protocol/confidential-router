import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithSession, TEST_WORKSPACES } from '../../test-utils';
import { typedSessionMock } from '../typed-session';
import { feedbackOfferMock } from './feedback-mocks';
import { FeedbackPrompt } from './feedback-prompt';

const pathname = vi.hoisted(() => ({ current: '/' }));
// `SessionProvider` reaches for `useRouter` to send an expired session back to
// sign-in, so the mock has to answer that too.
vi.mock('next/navigation', () => ({
  usePathname: () => pathname.current,
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const FORM_URL = 'https://form.example/to/aBcDeF?t=signed-token';

/** The active workspace is the first one the session returns. */
function workspaces(balanceMicros: string) {
  return [{ ...TEST_WORKSPACES[0], balanceMicros }, TEST_WORKSPACES[1]];
}

function render(balanceMicros: string, eligible = true) {
  return renderWithSession(<FeedbackPrompt />, {
    mocks: [
      typedSessionMock(workspaces(balanceMicros)),
      feedbackOfferMock(eligible ? { eligible: true, formUrl: FORM_URL } : { eligible: false }),
    ],
  });
}

beforeEach(() => {
  pathname.current = '/';
});

describe('FeedbackPrompt', () => {
  it('offers the grant where a request has just been refused for want of credit', async () => {
    render('0');

    expect(await screen.findByTestId('feedback-prompt')).toHaveTextContent('another $100.00');
    expect(screen.getByRole('link', { name: /Give feedback/ })).toHaveAttribute('href', FORM_URL);
  });

  it('is a strip and not a dialog, so it never blocks the page underneath', async () => {
    render('0');

    // Someone whose run has just stopped is entitled to go and read their logs
    // without answering a survey first.
    const prompt = await screen.findByTestId('feedback-prompt');
    expect(prompt).toHaveAttribute('role', 'status');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('stays away while there is still credit to spend', async () => {
    render('12000000');

    await waitFor(() => expect(screen.queryByTestId('feedback-prompt')).toBeNull());
  });

  it('stays away on the Credits screen, which has a card of its own', async () => {
    pathname.current = '/credits';
    render('0');

    await waitFor(() => expect(screen.queryByTestId('feedback-prompt')).toBeNull());
  });

  it('stays away from an account the server is not offering anything to', async () => {
    render('0', false);

    await waitFor(() => expect(screen.queryByTestId('feedback-prompt')).toBeNull());
  });
});
