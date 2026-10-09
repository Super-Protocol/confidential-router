import type { MockLink } from '@apollo/client/testing';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { markSignedIn, SIGNED_IN_COOKIE_NAME } from '../../lib/signed-in-cookie';
import { renderWithApollo } from '../../test-utils';
import { ForgotPasswordForm } from './forgot-password-form';
import { SIGN_IN_OPTIONS_QUERY } from './operations';
import { ResetPasswordForm } from './reset-password-form';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

function optionsMock(passwordReset = true) {
  return {
    request: { query: SIGN_IN_OPTIONS_QUERY },
    result: {
      data: {
        signInOptions: {
          __typename: 'SignInOptions',
          bootstrap: false,
          github: false,
          google: false,
          magicLink: true,
          password: true,
          passwordMinLength: 12,
          passwordReset,
          inviteRequired: false,
        },
      },
    },
    maxUsageCount: Number.POSITIVE_INFINITY,
  } satisfies MockLink.MockedResponse;
}

function lastCall(): { url: string; body: Record<string, unknown> } {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return { url, body: JSON.parse(String(init.body)) };
}

describe('ForgotPasswordForm', () => {
  it('asks the router for a link and confirms in the router’s own words', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: true }));
    renderWithApollo(<ForgotPasswordForm />, { mocks: [optionsMock()] });

    await userEvent.type(await screen.findByLabelText('Email'), 'someone@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Email me a reset link' }));

    expect(await screen.findByText(/has an account here, a reset link is on its way/)).toBeInTheDocument();
    const { url, body } = lastCall();
    expect(url).toMatch(/\/auth\/request-password-reset$/);
    // No redirect of the console's choosing: the router builds the link itself.
    expect(body).toEqual({ email: 'someone@example.com' });
  });

  it('says so when this network has asked too often', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ code: 'RATE_LIMITED', message: 'Too many' }, 429));
    renderWithApollo(<ForgotPasswordForm />, { mocks: [optionsMock()] });

    await userEvent.type(await screen.findByLabelText('Email'), 'someone@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Email me a reset link' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Too many reset requests/);
  });

  it('offers no form on a deployment that cannot send mail', async () => {
    renderWithApollo(<ForgotPasswordForm />, { mocks: [optionsMock(false)] });

    expect(await screen.findByText(/cannot send mail/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
  });
});

describe('ResetPasswordForm', () => {
  function openWith(search: string) {
    vi.stubGlobal('location', { ...window.location, search, pathname: '/reset-password' });
    return renderWithApollo(<ResetPasswordForm />, { mocks: [optionsMock()] });
  }

  async function fill(password: string, confirmation = password) {
    await userEvent.type(await screen.findByLabelText('New password'), password);
    await userEvent.type(screen.getByLabelText('Repeat it'), confirmation);
  }

  it('sets the new password with the token from the link', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: true }));
    openWith('?token=tok123');

    await fill('a-brand-new-password');
    await userEvent.click(screen.getByRole('button', { name: 'Set new password' }));

    expect(await screen.findByText('Password changed')).toBeInTheDocument();
    const { url, body } = lastCall();
    expect(url).toMatch(/\/auth\/reset-password$/);
    expect(body).toEqual({ token: 'tok123', newPassword: 'a-brand-new-password' });
  });

  it('drops this browser’s routing marker, since every session was revoked', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: true }));
    markSignedIn();
    openWith('?token=tok123');

    await fill('a-brand-new-password');
    await userEvent.click(screen.getByRole('button', { name: 'Set new password' }));

    await screen.findByText('Password changed');
    expect(document.cookie).not.toContain(`${SIGNED_IN_COOKIE_NAME}=`);
  });

  it('holds the button to the deployment’s minimum and to a matching repeat', async () => {
    openWith('?token=tok123');

    await fill('short', 'short');
    expect(await screen.findByText('At least 12 characters.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set new password' })).toBeDisabled();

    await userEvent.clear(screen.getByLabelText('New password'));
    await userEvent.clear(screen.getByLabelText('Repeat it'));
    await fill('a-brand-new-password', 'a-different-password');
    expect(screen.getByText('The two passwords do not match.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set new password' })).toBeDisabled();
  });

  it('explains a used or expired link and offers a new one', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ code: 'INVALID_TOKEN', message: 'Invalid token' }, 400));
    openWith('?token=spent');

    await fill('a-brand-new-password');
    await userEvent.click(screen.getByRole('button', { name: 'Set new password' }));

    expect(await screen.findByText('This link no longer works')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Send a new link' })).toHaveAttribute('href', '/forgot-password');
  });

  it('treats a link with no token as a dead one, without asking the router', async () => {
    openWith('');

    expect(await screen.findByText('This link no longer works')).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).not.toHaveBeenCalled());
  });
});
