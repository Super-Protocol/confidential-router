import type { MockLink } from '@apollo/client/testing';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithApollo } from '../../test-utils';
import { SIGN_IN_OPTIONS_QUERY } from './operations';
import { SignInForm } from './sign-in-form';

const fetchMock = vi.fn();
const assign = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('location', { ...window.location, assign });
  fetchMock.mockReset();
  assign.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 400) {
  return { ok, status, json: async () => body } as unknown as Response;
}

/** Everything on, which is how the development deployment is configured. */
function optionsMock(overrides: Partial<Record<'bootstrap' | 'github' | 'google' | 'magicLink', boolean>> = {}) {
  return {
    request: { query: SIGN_IN_OPTIONS_QUERY },
    result: {
      data: {
        signInOptions: {
          __typename: 'SignInOptions',
          bootstrap: false,
          github: true,
          google: true,
          magicLink: true,
          ...overrides,
        },
      },
    },
    maxUsageCount: Number.POSITIVE_INFINITY,
  } satisfies MockLink.MockedResponse;
}

function renderForm(mocks: MockLink.MockedResponse[] = [optionsMock()]) {
  return renderWithApollo(<SignInForm />, { mocks });
}

describe('SignInForm', () => {
  it('offers both providers and the magic link', async () => {
    renderForm();

    expect(await screen.findByRole('button', { name: /Continue with GitHub/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Continue with Google/ })).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
  });

  it('keeps the magic-link button disabled until an address is typed', async () => {
    renderForm();
    const submit = await screen.findByRole('button', { name: 'Email me a link' });

    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Email'), 'dev@example.com');
    expect(submit).toBeEnabled();
  });

  it('sends the address to the magic-link endpoint and confirms', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    renderForm();

    await userEvent.type(await screen.findByLabelText('Email'), 'dev@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Email me a link' }));

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/auth\/sign-in\/magic-link$/);
    expect(JSON.parse(init.body)).toMatchObject({ email: 'dev@example.com' });
    expect(init.credentials).toBe('include');
    expect(await screen.findByText('Check your inbox')).toBeInTheDocument();
    expect(screen.getByText('dev@example.com')).toBeInTheDocument();
  });

  it('lets the viewer go back and use a different address', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    renderForm();

    await userEvent.type(await screen.findByLabelText('Email'), 'dev@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Email me a link' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Use a different address' }));

    expect(await screen.findByLabelText('Email')).toBeInTheDocument();
  });

  it('navigates to the provider authorize URL', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ url: 'https://github.com/login/oauth/authorize?x=1' }));
    renderForm();

    await userEvent.click(await screen.findByRole('button', { name: /Continue with GitHub/ }));

    expect(assign).toHaveBeenCalledWith('https://github.com/login/oauth/authorize?x=1');
  });

  it('says so when a provider is not configured, instead of navigating nowhere', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    renderForm();

    await userEvent.click(await screen.findByRole('button', { name: /Continue with Google/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('google sign-in is not configured');
    expect(assign).not.toHaveBeenCalled();
  });

  it('reports an unreachable API rather than hanging on "Sending…"', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    renderForm();

    await userEvent.type(await screen.findByLabelText('Email'), 'dev@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Email me a link' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach the API');
    expect(screen.getByRole('button', { name: 'Email me a link' })).toBeEnabled();
  });

  it('does not render a server error message verbatim when the response is not JSON', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => Promise.reject(new Error('nope')),
    } as unknown as Response);
    renderForm();

    await userEvent.type(await screen.findByLabelText('Email'), 'dev@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Email me a link' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Sign-in failed. Please try again.');
  });
});

describe('SignInForm, on what the deployment offers', () => {
  it('hides a provider the deployment has no app for', async () => {
    renderForm([optionsMock({ google: false })]);

    expect(await screen.findByRole('button', { name: /Continue with GitHub/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Continue with Google/ })).not.toBeInTheDocument();
  });

  it('hides the magic-link form when the deployment has no mailer', async () => {
    renderForm([optionsMock({ magicLink: false })]);

    expect(await screen.findByRole('button', { name: /Continue with GitHub/ })).toBeInTheDocument();
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
  });

  it('offers the bootstrap path only while the API reports it', async () => {
    renderForm();
    await screen.findByRole('button', { name: /Continue with GitHub/ });
    expect(screen.queryByRole('button', { name: 'Have a bootstrap token?' })).not.toBeInTheDocument();

    renderForm([optionsMock({ bootstrap: true })]);
    expect(await screen.findByRole('button', { name: 'Have a bootstrap token?' })).toBeInTheDocument();
  });

  it('offers only the bootstrap path on a fresh marketplace deployment', async () => {
    renderForm([optionsMock({ bootstrap: true, github: false, google: false, magicLink: false })]);

    expect(await screen.findByRole('button', { name: 'Have a bootstrap token?' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Continue with/ })).not.toBeInTheDocument();
  });

  it('says so when the deployment has no sign-in method at all', async () => {
    renderForm([optionsMock({ bootstrap: false, github: false, google: false, magicLink: false })]);

    expect(await screen.findByRole('alert')).toHaveTextContent('no sign-in method configured');
  });

  it('offers every path when the query fails, rather than locking the viewer out', async () => {
    renderForm([{ request: { query: SIGN_IN_OPTIONS_QUERY }, error: new Error('API is down') }]);

    expect(await screen.findByRole('button', { name: /Continue with GitHub/ })).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    // Except bootstrap: unlike the others it is normally unavailable, so a
    // failed query must not advertise it.
    expect(screen.queryByRole('button', { name: 'Have a bootstrap token?' })).not.toBeInTheDocument();
  });

  it('renders no clickable path until the answer arrives', () => {
    renderForm();

    expect(screen.getByTestId('sign-in-options-loading')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('SignInForm, the bootstrap path', () => {
  async function openBootstrap() {
    renderForm([optionsMock({ bootstrap: true })]);
    await userEvent.click(await screen.findByRole('button', { name: 'Have a bootstrap token?' }));
    return screen.getByLabelText('Bootstrap token');
  }

  it('trades the token for a session and reloads onto the console', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ user: { id: 'user-1', email: 'admin@example.com' } }));

    await userEvent.type(await openBootstrap(), 'a-sixteen-char-token');
    await userEvent.click(screen.getByRole('button', { name: 'Create the first account' }));

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/auth\/bootstrap$/);
    expect(JSON.parse(init.body)).toEqual({ token: 'a-sixteen-char-token' });
    expect(init.credentials).toBe('include');
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/'));
  });

  it('never puts the token in the URL', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ user: { id: 'user-1', email: 'admin@example.com' } }));

    await userEvent.type(await openBootstrap(), 'a-sixteen-char-token');
    await userEvent.click(screen.getByRole('button', { name: 'Create the first account' }));

    const [url] = fetchMock.mock.calls[0];
    expect(url).not.toContain('a-sixteen-char-token');
    await waitFor(() => expect(assign).toHaveBeenCalled());
    expect(assign.mock.calls[0][0]).not.toContain('a-sixteen-char-token');
  });

  it('explains a token the router rejected', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: 'The bootstrap token is not valid.' }, false, 401));

    await userEvent.type(await openBootstrap(), 'wrong-token-here');
    await userEvent.click(screen.getByRole('button', { name: 'Create the first account' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('does not match');
    expect(assign).not.toHaveBeenCalled();
  });

  it('explains a deployment that has already been set up', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, false, 404));

    await userEvent.type(await openBootstrap(), 'a-sixteen-char-token');
    await userEvent.click(screen.getByRole('button', { name: 'Create the first account' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('already has an account');
  });

  it('goes back to the ordinary sign-in card', async () => {
    await openBootstrap();
    await userEvent.click(screen.getByRole('button', { name: 'Back to sign in' }));

    expect(await screen.findByLabelText('Email')).toBeInTheDocument();
  });

  it('keeps the submit button disabled until a token is typed', async () => {
    await openBootstrap();

    expect(screen.getByRole('button', { name: 'Create the first account' })).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Bootstrap token'), 'x');
    expect(screen.getByRole('button', { name: 'Create the first account' })).toBeEnabled();
  });
});
