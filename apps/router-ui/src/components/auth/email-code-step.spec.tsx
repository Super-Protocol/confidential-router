import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SignInMailStateName } from '../../generated/graphql';
import { renderWithApollo } from '../../test-utils';
import { signInMailStateMock } from './auth-mocks';
import { EmailCodeStep } from './email-code-step';

const EMAIL = 'alexeykheben@superprotocol.com';

const SLOW_MAIL = /Nothing in the inbox\? Check spam first/;
const REJECTED = /Mail to this address is being rejected/;

function renderStep(state?: SignInMailStateName) {
  return renderWithApollo(
    <EmailCodeStep
      email={EMAIL}
      length={6}
      submitLabel="Sign in"
      submittingLabel="Signing in…"
      pending={null}
      error={null}
      resent={false}
      onSubmit={vi.fn()}
      onResend={vi.fn()}
      onChangeAddress={vi.fn()}
    />,
    { mocks: state ? [signInMailStateMock(state)] : [] },
  );
}

describe('the code-entry screen', () => {
  it('says the mail may simply be slow, while nothing says otherwise', async () => {
    renderStep();

    expect(await screen.findByText(SLOW_MAIL)).toBeInTheDocument();
    expect(screen.queryByTestId('email-code-rejected')).not.toBeInTheDocument();
  });

  /**
   * The defect SUP-551 is about: for an address on the provider's suppression
   * list, every clause of "check spam, it may be slow" is false — so the screen
   * must stop saying it.
   */
  it('stops claiming the mail is slow once the router knows the address rejects it', async () => {
    renderStep('REJECTING');

    expect(await screen.findByTestId('email-code-rejected')).toHaveTextContent(REJECTED);
    expect(screen.queryByText(SLOW_MAIL)).not.toBeInTheDocument();
  });

  it('keeps the ordinary copy for an address the provider is merely slow with', async () => {
    renderStep('DELAYED');

    expect(await screen.findByText(SLOW_MAIL)).toBeInTheDocument();
  });

  /**
   * A lookup that failed must cost the screen nothing it had before: the honest
   * line is an addition, and a router that could not answer is not evidence
   * that the address is fine *or* that it is not.
   */
  it('falls back to the ordinary copy when the lookup fails', async () => {
    renderWithApollo(
      <EmailCodeStep
        email={EMAIL}
        length={6}
        submitLabel="Sign in"
        submittingLabel="Signing in…"
        pending={null}
        error={null}
        resent={false}
        onSubmit={vi.fn()}
        onResend={vi.fn()}
        onChangeAddress={vi.fn()}
      />,
      { mocks: [{ request: { query: signInMailStateMock().request.query }, error: new Error('offline') }] },
    );

    await waitFor(() => expect(screen.getByText(SLOW_MAIL)).toBeInTheDocument());
    expect(screen.queryByTestId('email-code-rejected')).not.toBeInTheDocument();
  });
});
