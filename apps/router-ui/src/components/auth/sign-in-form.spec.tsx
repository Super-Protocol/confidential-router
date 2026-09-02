import type { MockLink } from '@apollo/client/testing';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSignedIn, SIGNED_IN_COOKIE_NAME } from '../../lib/signed-in-cookie';
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
  clearSignedIn();
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 400) {
  return { ok, status, json: async () => body } as unknown as Response;
}

type Offers = Partial<{
  bootstrap: boolean;
  github: boolean;
  google: boolean;
  magicLink: boolean;
  password: boolean;
  passwordMinLength: number;
}>;

/**
 * The development deployment: both providers and a mailer, no passwords —
 * ADR-004's original set, which is still what `nx serve` runs.
 */
function optionsMock(overrides: Offers = {}) {
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
          password: false,
          passwordMinLength: 12,
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
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
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

describe('SignInForm, the password path', () => {
  /** A marketplace deployment: passwords, and nothing else but the token. */
  const MAILER_LESS: Offers = { github: false, google: false, magicLink: false, password: true };

  it('asks for a password when the deployment offers one', async () => {
    renderForm([optionsMock(MAILER_LESS)]);

    expect(await screen.findByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Email me a link' })).not.toBeInTheDocument();
  });

  it('signs in and reloads onto the console', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    renderForm([optionsMock(MAILER_LESS)]);

    await userEvent.type(await screen.findByLabelText('Email'), 'dev@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'correct-horse-battery');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/auth\/sign-in\/email$/);
    expect(JSON.parse(init.body)).toMatchObject({ email: 'dev@example.com', password: 'correct-horse-battery' });
    expect(init.credentials).toBe('include');
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/'));
  });

  it('raises the console\u2019s routing marker before it leaves the page', async () => {
    // router-api's session cookie is set on the API's hostname and is invisible
    // here; the marker on the console's own host is what `proxy.ts` reads, and
    // without it the browser bounces straight back to `/login` (SUP-113).
    fetchMock.mockResolvedValue(jsonResponse({}));
    renderForm([optionsMock(MAILER_LESS)]);

    await userEvent.type(await screen.findByLabelText('Email'), 'dev@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'correct-horse-battery');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(document.cookie).toContain(`${SIGNED_IN_COOKIE_NAME}=1`));
  });

  it('never puts the password in the URL', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    renderForm([optionsMock(MAILER_LESS)]);

    await userEvent.type(await screen.findByLabelText('Email'), 'dev@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'correct-horse-battery');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(fetchMock.mock.calls[0][0]).not.toContain('correct-horse-battery');
    await waitFor(() => expect(assign).toHaveBeenCalled());
    expect(assign.mock.calls[0][0]).not.toContain('correct-horse-battery');
  });

  it('says a rejected pair was rejected, without naming which half', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: 'Invalid email or password' }, false, 401));
    renderForm([optionsMock(MAILER_LESS)]);

    await userEvent.type(await screen.findByLabelText('Email'), 'dev@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'wrong-password-here');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('do not match an account here');
    expect(assign).not.toHaveBeenCalled();
  });

  it('links to sign-up where accounts can be created', async () => {
    renderForm([optionsMock(MAILER_LESS)]);

    expect(await screen.findByRole('link', { name: 'Create one' })).toHaveAttribute('href', '/signup');
  });

  it('does not, where they cannot', async () => {
    renderForm();

    await screen.findByRole('button', { name: /Continue with GitHub/ });
    expect(screen.queryByRole('link', { name: 'Create one' })).not.toBeInTheDocument();
  });

  it('offers the magic link as the alternative when the deployment has both', async () => {
    renderForm([optionsMock({ password: true })]);

    // Password first: it signs the viewer in here rather than via an inbox.
    expect(await screen.findByLabelText('Password')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Email me a link instead' }));
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Email me a link' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Use a password instead' }));
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
  });

  it('keeps the address across the switch — it is the same address either way', async () => {
    renderForm([optionsMock({ password: true })]);

    await userEvent.type(await screen.findByLabelText('Email'), 'dev@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Email me a link instead' }));

    expect(screen.getByLabelText('Email')).toHaveValue('dev@example.com');
  });

  it('offers no switch when the deployment has only one of the two', async () => {
    renderForm([optionsMock(MAILER_LESS)]);

    await screen.findByLabelText('Password');
    expect(screen.queryByRole('button', { name: /instead/ })).not.toBeInTheDocument();
  });

  it('keeps the submit button disabled until both fields are filled', async () => {
    renderForm([optionsMock(MAILER_LESS)]);
    const submit = await screen.findByRole('button', { name: 'Sign in' });

    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Email'), 'dev@example.com');
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Password'), 'correct-horse-battery');
    expect(submit).toBeEnabled();
  });
});
