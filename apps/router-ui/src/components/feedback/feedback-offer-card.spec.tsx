import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithApollo } from '../../test-utils';
import { feedbackOfferMock } from './feedback-mocks';
import { FeedbackOfferCard } from './feedback-offer-card';

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast: toasts }));

const FORM_URL = 'https://form.example/to/aBcDeF?t=signed-token';

beforeEach(() => {
  toasts.success.mockReset();
});

describe('FeedbackOfferCard', () => {
  it('renders nothing for an account the server is not offering the grant to', async () => {
    renderWithApollo(<FeedbackOfferCard />, { mocks: [feedbackOfferMock({ eligible: false })] });

    await waitFor(() => expect(screen.queryByTestId('feedback-offer')).toBeNull());
  });

  it('offers the grant with the amount the server named, as a real link to the form', async () => {
    renderWithApollo(<FeedbackOfferCard />, {
      mocks: [feedbackOfferMock({ eligible: true, formUrl: FORM_URL, grantMicros: '100000000' })],
    });

    expect(await screen.findByTestId('feedback-offer')).toHaveTextContent('another $100.00');
    const link = screen.getByRole('link', { name: /Give feedback/ });
    // A real link and not a scripted popup: the form is another origin, and a
    // window opened from a handler is what browsers block.
    expect(link).toHaveAttribute('href', FORM_URL);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('says the credit is on its way once the form has been opened', async () => {
    const user = (await import('@testing-library/user-event')).default.setup();
    renderWithApollo(<FeedbackOfferCard />, {
      mocks: [feedbackOfferMock({ eligible: true, formUrl: FORM_URL })],
    });

    await user.click(await screen.findByRole('link', { name: /Give feedback/ }));

    // Honest about the gap rather than showing a stale zero: the webhook has not
    // arrived yet, and the console says so.
    expect(await screen.findByText(/lands within a minute/)).toBeInTheDocument();
  });

  it('announces the grant and refreshes the balance when it lands', async () => {
    const user = (await import('@testing-library/user-event')).default.setup();
    const onGranted = vi.fn();
    renderWithApollo(<FeedbackOfferCard onGranted={onGranted} />, {
      mocks: [
        feedbackOfferMock({ eligible: true, formUrl: FORM_URL, times: 1 }),
        feedbackOfferMock({
          eligible: false,
          reason: 'ALREADY_GRANTED',
          granted: { creditTransactionId: 'txn-9', grantMicros: '100000000', appliedAt: '2026-09-25T12:00:00.000Z' },
        }),
      ],
    });

    await user.click(await screen.findByRole('link', { name: /Give feedback/ }));

    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith(expect.stringContaining('$100')));
    expect(onGranted).toHaveBeenCalled();
    expect(screen.queryByTestId('feedback-offer')).toBeNull();
  });
});
