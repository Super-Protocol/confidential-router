import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONSOLE_EVENTS_PATH } from '../../lib/console-analytics';
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

/** The analytics ingest is the only request this strip makes over `fetch`. */
const fetchMock = vi.fn();

// The path the console actually posts to, imported rather than re-spelled: a
// third copy of the literal is how these two specs came to hold the first
// spelling for a release after SUP-463 renamed it off a blocked path.
const INGEST = CONSOLE_EVENTS_PATH;

beforeEach(() => {
  pathname.current = '/';
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, status: 202, json: async () => ({}) } as unknown as Response);
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function ingested(): Record<string, unknown> | undefined {
  const call = fetchMock.mock.calls.find(([url]) => String(url).includes(INGEST)) as [string, RequestInit] | undefined;
  return call ? JSON.parse(call[1].body as string) : undefined;
}

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

  it('reports the click as the banner, so the two surfaces can be told apart', async () => {
    const user = (await import('@testing-library/user-event')).default.setup();
    render('0');

    await user.click(await screen.findByRole('link', { name: /Give feedback/ }));

    // The same event the Credits card sends, with the one property that says
    // which of them the viewer actually answered.
    await waitFor(() => expect(ingested()).toBeDefined());
    expect(ingested()).toEqual({
      event: 'feedback_form_opened',
      properties: { source: 'balance_banner', grant_eligible: true },
    });
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
