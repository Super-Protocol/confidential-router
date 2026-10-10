import type { MockLink } from '@apollo/client/testing';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INVITE_COOKIE_NAME } from '../../lib/invite';
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
  adminRecovery: boolean;
  github: boolean;
  google: boolean;
  emailCode: boolean;
  emailCodeLength: number;
  magicLink: boolean;
  inviteRequired: boolean;
}>;

/**
 * The development deployment: both providers and a mailer, which is what
 * `nx serve` runs. A mailer means a code can be mailed; the link beside it is
 * the development extra a production deployment turns off.
 */
function optionsMock(overrides: Offers = {}) {
  return {
    request: { query: SIGN_IN_OPTIONS_QUERY },
    result: {
      data: {
        signInOptions: {
          __typename: 'SignInOptions',
          bootstrap: false,
          adminRecovery: false,
          github: true,
          google: true,
          emailCode: true,
          emailCodeLength: 6,
          magicLink: true,
          inviteRequired: false,
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

/** A deployment whose mailer sends links only — the code path is not on the card. */
const LINK_ONLY: Offers = { emailCode: false };

/** A production deployment with a mailer: a code, and nothing else. */
const CODE_ONLY: Offers = { github: false, google: false, magicLink: false };

/**
 * Answers the two email-code routes by path. A test that reached for
 * `calls[0]` would be asserting on whichever request happened to be first.
 */
function routeCode(handlers: { send?: Response; signIn?: Response } = {}): void {
  fetchMock.mockImplementation((url: string) =>
    Promise.resolve(
      String(url).includes('/auth/sign-in/email-otp')
        ? (handlers.signIn ?? jsonResponse({ token: 't', user: { id: 'user-1' } }))
        : (handlers.send ?? jsonResponse({ success: true })),
    ),
  );
}

function callsTo(fragment: string): [string, RequestInit][] {
  return fetchMock.mock.calls.filter(([url]) => String(url).includes(fragment)) as [string, RequestInit][];
}

function bodyOf(fragment: string, index = 0): Record<string, unknown> {
  const call = callsTo(fragment)[index];
  expect(call, `no request #${index} to ${fragment}`).toBeDefined();
  return JSON.parse(call[1].body as string);
}

const SEND = '/auth/email-otp/send-verification-otp';
const SIGN_IN = '/auth/sign-in/email-otp';

/** Types an address and asks for a code, leaving the card on its code step. */
async function requestCode(email = 'dev@example.com') {
  await userEvent.type(await screen.findByLabelText('Email'), email);
  await userEvent.click(screen.getByRole('button', { name: 'Email me a code' }));
  return screen.findByLabelText('Code');
}

describe('SignInForm', () => {
  it('offers both providers and an address to mail', async () => {
    renderForm();

    expect(await screen.findByRole('button', { name: /Continue with GitHub/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Continue with Google/ })).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
  });

  it('keeps the magic-link button disabled until an address is typed', async () => {
    renderForm([optionsMock(LINK_ONLY)]);
    const submit = await screen.findByRole('button', { name: 'Email me a link' });

    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Email'), 'dev@example.com');
    expect(submit).toBeEnabled();
  });

  it('sends the address to the magic-link endpoint and confirms', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    renderForm([optionsMock(LINK_ONLY)]);

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
    renderForm([optionsMock(LINK_ONLY)]);

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
    renderForm([optionsMock(LINK_ONLY)]);

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
    renderForm([optionsMock(LINK_ONLY)]);

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

  it('asks for no address when the deployment has no mailer', async () => {
    renderForm([optionsMock({ emailCode: false, magicLink: false })]);

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
    renderForm([optionsMock({ bootstrap: true, github: false, google: false, emailCode: false, magicLink: false })]);

    expect(await screen.findByRole('button', { name: 'Have a bootstrap token?' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Continue with/ })).not.toBeInTheDocument();
  });

  it('says so when the deployment has no sign-in method at all', async () => {
    renderForm([optionsMock({ github: false, google: false, emailCode: false, magicLink: false })]);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('no sign-in method configured');
    expect(alert).not.toHaveTextContent(/password/i);
  });

  it('says what the card is for without mentioning a password', async () => {
    const { unmount } = renderForm();
    expect(await screen.findByText('Sign in with a code mailed to your address, or a provider.')).toBeInTheDocument();
    unmount();

    renderForm([optionsMock({ emailCode: false, magicLink: false })]);
    expect(await screen.findByText(/This deployment cannot send mail/)).toHaveTextContent('first-sign-in token');
  });

  it('offers every path when the query fails, rather than locking the viewer out', async () => {
    renderForm([{ request: { query: SIGN_IN_OPTIONS_QUERY }, error: new Error('API is down') }]);

    expect(await screen.findByRole('button', { name: /Continue with GitHub/ })).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Email me a code' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Email me a link instead' })).toBeInTheDocument();
    // Except the two token paths: unlike the others they are normally
    // unavailable, so a failed query must not advertise either.
    expect(screen.queryByRole('button', { name: 'Have a bootstrap token?' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /first-sign-in token/ })).not.toBeInTheDocument();
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

/**
 * The administrator's way back in (SUP-269): the bootstrap token, once the
 * account it created exists. Sign-in is otherwise a mailed code, so this is what
 * keeps a deployment that cannot mail one from losing its administrator.
 */
describe('SignInForm, administrator recovery', () => {
  const RECOVERY = 'Administrator: use the first-sign-in token';

  it('is offered only while the API reports it', async () => {
    const { unmount } = renderForm();
    await screen.findByRole('button', { name: /Continue with GitHub/ });
    expect(screen.queryByRole('button', { name: RECOVERY })).not.toBeInTheDocument();
    unmount();

    renderForm([optionsMock({ adminRecovery: true })]);
    expect(await screen.findByRole('button', { name: RECOVERY })).toBeInTheDocument();
    // Not the first-sign-in offer: there is an account, and nothing to set up.
    expect(screen.queryByRole('button', { name: 'Have a bootstrap token?' })).not.toBeInTheDocument();
  });

  it('opens the token form, worded for an account that already exists', async () => {
    renderForm([optionsMock({ adminRecovery: true })]);

    await userEvent.click(await screen.findByRole('button', { name: RECOVERY }));

    expect(screen.getByRole('heading', { name: 'Administrator sign-in' })).toBeInTheDocument();
    expect(screen.getByLabelText('First-sign-in token')).toBeInTheDocument();
    // The first-sign-in copy would be a lie here: nothing is created.
    expect(screen.queryByText(/creates the first account/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create the first account' })).not.toBeInTheDocument();
  });

  it('trades the token for a session through the same endpoint', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ user: { id: 'user-1', email: 'admin@example.com' } }));
    renderForm([optionsMock({ adminRecovery: true })]);

    await userEvent.click(await screen.findByRole('button', { name: RECOVERY }));
    await userEvent.type(screen.getByLabelText('First-sign-in token'), 'a-sixteen-char-token');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in as administrator' }));

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/auth\/bootstrap$/);
    expect(JSON.parse(init.body)).toEqual({ token: 'a-sixteen-char-token' });
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/'));
  });

  it('explains a deployment that stopped accepting the token, without claiming it has just been set up', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, false, 404));
    renderForm([optionsMock({ adminRecovery: true })]);

    await userEvent.click(await screen.findByRole('button', { name: RECOVERY }));
    await userEvent.type(screen.getByLabelText('First-sign-in token'), 'a-sixteen-char-token');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in as administrator' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('no longer accepts a first-sign-in token');
  });

  it('is still offered, and is not "nothing", on a deployment that can neither mail nor redirect', async () => {
    renderForm([
      optionsMock({ adminRecovery: true, github: false, google: false, emailCode: false, magicLink: false }),
    ]);

    expect(await screen.findByRole('button', { name: RECOVERY })).toBeInTheDocument();
    expect(screen.queryByText(/no sign-in method configured/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
  });
});

/**
 * Sign-in by a code mailed to the address (SUP-269) — the only way an account
 * signs in by mail, and the same request that creates one.
 */
describe('SignInForm, the emailed-code path', () => {
  it('asks for an address and nothing else', async () => {
    renderForm([optionsMock(CODE_ONLY)]);

    expect(await screen.findByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Email me a code' })).toBeInTheDocument();
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /forgot/i })).not.toBeInTheDocument();
  });

  it('keeps the button disabled until an address is typed', async () => {
    renderForm([optionsMock(CODE_ONLY)]);
    const submit = await screen.findByRole('button', { name: 'Email me a code' });

    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Email'), 'dev@example.com');
    expect(submit).toBeEnabled();
  });

  it('requests a code and moves to the code step', async () => {
    routeCode();
    renderForm([optionsMock(CODE_ONLY)]);

    const field = await requestCode();

    expect(callsTo(SEND)).toHaveLength(1);
    expect(bodyOf(SEND)).toEqual({ email: 'dev@example.com', type: 'sign-in' });
    expect(callsTo(SEND)[0][1].credentials).toBe('include');
    expect(screen.getByRole('heading', { name: 'Enter your code' })).toBeInTheDocument();
    expect(field).toHaveAttribute('inputmode', 'numeric');
    expect(field).toHaveAttribute('autocomplete', 'one-time-code');
    expect(field).toHaveAttribute('maxlength', '6');
    expect(field).toHaveFocus();
  });

  it('says a code was sent without claiming the address has an account', async () => {
    routeCode();
    renderForm([optionsMock(CODE_ONLY)]);

    await requestCode();

    // The router mails any address and never says whether an account was behind
    // it, so neither can this.
    const said = screen.getByText(/We sent a 6-digit code to/);
    expect(said).toHaveTextContent(
      'We sent a 6-digit code to dev@example.com. It works once and expires in a few minutes.',
    );
    expect(document.body.textContent).not.toMatch(/your account|if an account|registered/i);
  });

  it('states the length the deployment reports', async () => {
    routeCode();
    renderForm([optionsMock({ ...CODE_ONLY, emailCodeLength: 8 })]);

    const field = await requestCode();

    expect(field).toHaveAttribute('maxlength', '8');
    expect(screen.getByText(/We sent a 8-digit code/)).toBeInTheDocument();
  });

  it('holds "Sign in" until the code has every digit', async () => {
    routeCode();
    renderForm([optionsMock(CODE_ONLY)]);
    const field = await requestCode();
    const submit = screen.getByRole('button', { name: 'Sign in' });

    expect(submit).toBeDisabled();
    await userEvent.type(field, '12345');
    expect(submit).toBeDisabled();
    await userEvent.type(field, '6');
    expect(submit).toBeEnabled();
  });

  it('takes digits only, and no more than a code has', async () => {
    routeCode();
    renderForm([optionsMock(CODE_ONLY)]);
    const field = await requestCode();

    await userEvent.type(field, '12a b3-4567890');

    expect(field).toHaveValue('123456');
  });

  it('accepts a pasted code with the spaces a mail client put in it', async () => {
    routeCode();
    renderForm([optionsMock(CODE_ONLY)]);
    const field = await requestCode();

    await userEvent.click(field);
    await userEvent.paste('123 456');

    expect(field).toHaveValue('123456');
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  it('signs in with the code and reloads onto the console', async () => {
    routeCode();
    renderForm([optionsMock(CODE_ONLY)]);

    await userEvent.type(await requestCode(), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(bodyOf(SIGN_IN)).toEqual({ email: 'dev@example.com', otp: '123456' });
    expect(callsTo(SIGN_IN)[0][1].credentials).toBe('include');
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/'));
  });

  it('raises the console’s routing marker before it leaves the page', async () => {
    // router-api's session cookie is set on the API's hostname and is invisible
    // here; the marker on the console's own host is what `proxy.ts` reads, and
    // without it the browser bounces straight back to `/login` (SUP-113).
    routeCode();
    renderForm([optionsMock(CODE_ONLY)]);

    await userEvent.type(await requestCode(), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(document.cookie).toContain(`${SIGNED_IN_COOKIE_NAME}=1`));
  });

  it('never puts the code in the URL', async () => {
    routeCode();
    renderForm([optionsMock(CODE_ONLY)]);

    await userEvent.type(await requestCode(), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(callsTo(SIGN_IN)[0][0]).not.toContain('123456');
    await waitFor(() => expect(assign).toHaveBeenCalled());
    expect(assign.mock.calls[0][0]).not.toContain('123456');
  });

  it('says a wrong code is wrong, and lets it be typed again', async () => {
    routeCode({ signIn: jsonResponse({ code: 'INVALID_OTP', message: 'Invalid OTP' }, false, 400) });
    renderForm([optionsMock(CODE_ONLY)]);
    const field = await requestCode();

    await userEvent.type(field, '000000');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('That code is not right');
    // Still there to be corrected: one digit off is the usual mistake.
    expect(screen.getByLabelText('Code')).toHaveValue('000000');
    expect(assign).not.toHaveBeenCalled();
    expect(document.cookie).not.toContain(SIGNED_IN_COOKIE_NAME);
  });

  it.each(['OTP_EXPIRED', 'TOO_MANY_ATTEMPTS'])('says a dead code is dead and offers a new one: %s', async (code) => {
    routeCode({ signIn: jsonResponse({ code, message: 'refused' }, false, 400) });
    renderForm([optionsMock(CODE_ONLY)]);

    await userEvent.type(await requestCode(), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('That code no longer works. Send a new one.');
    // The dead code is gone from the field, so the only live button is the one
    // that helps.
    expect(screen.getByLabelText('Code')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send a new code' })).toBeEnabled();
    expect(assign).not.toHaveBeenCalled();
  });

  it('tells a throttled attempt to wait, whichever of the two requests it was', async () => {
    const throttled = jsonResponse({ code: 'RATE_LIMITED', message: 'Too many sign-in attempts.' }, false, 429);
    routeCode({ signIn: throttled });
    const { unmount } = renderForm([optionsMock(CODE_ONLY)]);

    await userEvent.type(await requestCode(), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many attempts. Wait a minute and try again.');
    unmount();

    routeCode({ send: throttled });
    renderForm([optionsMock(CODE_ONLY)]);
    await userEvent.type(await screen.findByLabelText('Email'), 'dev@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Email me a code' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Too many attempts. Wait a minute and try again.');
    // No code was mailed, so there is no code step to stand on.
    expect(screen.queryByLabelText('Code')).not.toBeInTheDocument();
  });

  it('says so when the deployment turns out to have no mailer after all', async () => {
    // Only reachable from the fallback that offers everything: the options
    // query failed, so the card guessed.
    routeCode({ send: jsonResponse({}, false, 404) });
    renderForm([{ request: { query: SIGN_IN_OPTIONS_QUERY }, error: new Error('API is down') }]);

    await userEvent.type(await screen.findByLabelText('Email'), 'dev@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Email me a code' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('not available on this deployment');
    expect(screen.queryByLabelText('Code')).not.toBeInTheDocument();
  });

  it('reports an unreachable API rather than hanging on "Sending…"', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    renderForm([optionsMock(CODE_ONLY)]);

    await userEvent.type(await screen.findByLabelText('Email'), 'dev@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Email me a code' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach the API');
    expect(screen.getByRole('button', { name: 'Email me a code' })).toBeEnabled();
  });

  it('sends a new code on request, and starts the field over', async () => {
    routeCode();
    renderForm([optionsMock(CODE_ONLY)]);
    const field = await requestCode();
    await userEvent.type(field, '123');

    await userEvent.click(screen.getByRole('button', { name: 'Send a new code' }));

    expect(await screen.findByTestId('email-code-resent')).toHaveTextContent('A new code is on its way');
    expect(callsTo(SEND)).toHaveLength(2);
    expect(bodyOf(SEND, 1)).toEqual({ email: 'dev@example.com', type: 'sign-in' });
    expect(screen.getByLabelText('Code')).toHaveValue('');
  });

  it('goes back for a different address, keeping the one that was typed', async () => {
    routeCode();
    renderForm([optionsMock(CODE_ONLY)]);
    await requestCode();

    await userEvent.click(screen.getByRole('button', { name: 'Use a different address' }));

    expect(screen.queryByLabelText('Code')).not.toBeInTheDocument();
    expect(await screen.findByLabelText('Email')).toHaveValue('dev@example.com');
    expect(screen.getByRole('button', { name: 'Email me a code' })).toBeEnabled();
  });

  it('offers no code path on a deployment that cannot mail one', async () => {
    renderForm([optionsMock({ emailCode: false, magicLink: false })]);

    await screen.findByRole('button', { name: /Continue with GitHub/ });
    expect(screen.queryByRole('button', { name: 'Email me a code' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
  });

  it('links to sign-up where accounts can be created, saying where the visitor came from', async () => {
    renderForm([optionsMock(CODE_ONLY)]);

    // `from=login` is what lets `signup_started` tell this visitor apart from one
    // who opened the sign-up page directly (SUP-145).
    expect(await screen.findByRole('link', { name: 'Create one' })).toHaveAttribute('href', '/signup?from=login');
  });

  it('does not, where they cannot', async () => {
    renderForm([optionsMock(LINK_ONLY)]);

    await screen.findByRole('button', { name: /Continue with GitHub/ });
    expect(screen.queryByRole('link', { name: 'Create one' })).not.toBeInTheDocument();
  });

  it('offers the magic link as the alternative when the deployment has both', async () => {
    renderForm();

    // The code first: it signs in the browser the viewer is looking at.
    expect(await screen.findByRole('button', { name: 'Email me a code' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Email me a link instead' }));
    expect(screen.queryByRole('button', { name: 'Email me a code' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Email me a link' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Use a code instead' }));
    expect(screen.getByRole('button', { name: 'Email me a code' })).toBeInTheDocument();
  });

  it('mails a link, not a code, once the viewer has switched', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    renderForm();

    await userEvent.type(await screen.findByLabelText('Email'), 'dev@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Email me a link instead' }));
    await userEvent.click(screen.getByRole('button', { name: 'Email me a link' }));

    expect(callsTo('/auth/sign-in/magic-link')).toHaveLength(1);
    expect(callsTo(SEND)).toHaveLength(0);
    expect(await screen.findByText('Check your inbox')).toBeInTheDocument();
  });

  it('keeps the address across the switch — it is the same address either way', async () => {
    renderForm();

    await userEvent.type(await screen.findByLabelText('Email'), 'dev@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Email me a link instead' }));

    expect(screen.getByLabelText('Email')).toHaveValue('dev@example.com');
  });

  it.each([
    ['only a code', CODE_ONLY, 'Email me a code'],
    ['only a link', LINK_ONLY, 'Email me a link'],
  ])('offers no switch when the deployment has %s', async (_, offers, button) => {
    renderForm([optionsMock(offers)]);

    await screen.findByRole('button', { name: button });
    expect(screen.queryByRole('button', { name: /instead/ })).not.toBeInTheDocument();
  });
});

/**
 * An invitation reaches this screen more often than it looks. Every path here
 * creates the account on first use — a mailed code, a magic link and OAuth alike
 * — so an invited visitor who never opens `/signup` is registered from here, and
 * the code has to leave from here too, or the grant is silently lost (SUP-145).
 */
describe('an invitation carried to a sign-in screen', () => {
  beforeEach(() => {
    vi.stubGlobal('location', { ...window.location, search: '?invite=abcd-efgh', protocol: 'http:', assign });
  });

  afterEach(() => {
    // biome-ignore lint/suspicious/noDocumentCookie: clearing the cookie the code under test set, with the API the code under test uses.
    document.cookie = `${INVITE_COOKIE_NAME}=; max-age=0; path=/`;
  });

  it('publishes the code as a cookie before leaving for the provider', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ url: 'https://github.com/login/oauth/authorize?x=1' }));
    renderForm();

    await userEvent.click(await screen.findByRole('button', { name: 'Continue with GitHub' }));

    // The callback is a URL the provider built: a cookie on our origin is the only
    // thing of ours that survives it.
    expect(document.cookie).toContain(`${INVITE_COOKIE_NAME}=ABCDEFGH`);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).callbackURL).toBe('/?invite=ABCDEFGH');
  });

  it('carries the code in the callbackURL of a magic link', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    renderForm();

    await userEvent.type(await screen.findByLabelText('Email'), 'invited@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Email me a link instead' }));
    await userEvent.click(screen.getByRole('button', { name: 'Email me a link' }));

    // `callbackURL` is the only thing that survives from the request that asks for
    // the mail to the one that creates the account.
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).callbackURL).toBe('/?invite=ABCDEFGH');
  });

  it('rides the mailed-code sign-in, which creates the account for an address that has none', async () => {
    routeCode();
    renderForm([optionsMock(CODE_ONLY)]);

    await userEvent.type(await requestCode('invited@example.com'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    // Sent whether or not the address has an account: redemption lives in
    // account creation and nowhere else, so an existing one is not topped up
    // (SUP-142) and the console does not have to know which this is.
    expect(bodyOf(SIGN_IN)).toEqual({ email: 'invited@example.com', otp: '123456', inviteCode: 'ABCDEFGH' });
    // The request for the code carries nothing of it: a code is asked for by
    // address alone.
    expect(bodyOf(SEND)).toEqual({ email: 'invited@example.com', type: 'sign-in' });
  });
});

/**
 * A sign-*up* this screen started and the router refused (SUP-173).
 *
 * A provider and a magic link finish as a navigation, so their refusal comes
 * back as `?error=` rather than as a rejected promise; a mailed code is this
 * screen's own request, and its refusal is a 403. Either way it has to be said
 * *here*, because the button that caused it is on this screen and pressing it
 * again is the way out.
 */
describe('an invite-only refusal carried back to the sign-in screen', () => {
  it('names the error callback it wants a refusal sent to, absolute so the router does not resolve it against its own origin', async () => {
    vi.stubGlobal('location', {
      ...window.location,
      origin: 'https://console.example',
      pathname: '/login',
      search: '',
      assign,
    });
    fetchMock.mockResolvedValue(jsonResponse({ url: 'https://github.com/login/oauth/authorize?x=1' }));
    renderForm();

    await userEvent.click(await screen.findByRole('button', { name: 'Continue with GitHub' }));

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).errorCallbackURL).toBe('https://console.example/login');
  });

  it('explains it, and points at the screen where a code can be entered', async () => {
    vi.stubGlobal('location', { ...window.location, search: '?error=invite_required', assign });
    fetchMock.mockResolvedValue(jsonResponse({}));
    renderForm();

    const alert = await screen.findByTestId('invite-refused-invite_required');
    expect(alert).toHaveTextContent('You need an invitation');
    expect(screen.getByRole('link', { name: 'Enter a code' })).toHaveAttribute('href', '/signup');
  });

  it('tells a claimed invitation apart from one that never worked', async () => {
    vi.stubGlobal('location', { ...window.location, search: '?error=invite_already_claimed', assign });
    fetchMock.mockResolvedValue(jsonResponse({}));
    renderForm();

    expect(await screen.findByTestId('invite-refused-invite_already_claimed')).toHaveTextContent(
      'already been claimed',
    );
  });

  it('leaves Better Auth’s own errors alone rather than mistranslating them', async () => {
    vi.stubGlobal('location', { ...window.location, search: '?error=INVALID_TOKEN', assign });
    fetchMock.mockResolvedValue(jsonResponse({}));
    renderForm();

    await screen.findByRole('button', { name: 'Continue with GitHub' });
    expect(screen.queryByText(/invitation/i)).not.toBeInTheDocument();
  });

  it('keeps the code for the retry, which the provider’s redirect stripped from the URL', async () => {
    vi.stubGlobal('location', { ...window.location, search: '?invite=abcd-efgh', protocol: 'http:', assign });
    fetchMock.mockResolvedValue(jsonResponse({}));
    renderForm();

    await screen.findByRole('button', { name: 'Continue with GitHub' });
    await waitFor(() => expect(window.localStorage.getItem('cr_invite')).toBe('ABCDEFGH'));
    window.localStorage.clear();
  });

  it.each([
    ['invite_required', 'You need an invitation'],
    ['invite_already_claimed', 'already been claimed'],
    ['invite_expired_or_unknown', 'cannot be used'],
  ])('explains a mailed-code sign-up the router refused, back on the card: %s', async (code, sentence) => {
    routeCode({ signIn: jsonResponse({ code, message: 'refused' }, false, 403) });
    renderForm([optionsMock({ ...CODE_ONLY, inviteRequired: true })]);

    await userEvent.type(await requestCode('stranger@example.com'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByTestId(`invite-refused-${code}`)).toHaveTextContent(sentence);
    expect(screen.getByRole('link', { name: 'Enter a code' })).toHaveAttribute('href', '/signup');
    // Checking the mailed code spent it, so the code step has nothing left to
    // offer: the card is back, ready to ask for another.
    expect(screen.queryByLabelText('Code')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Email me a code' })).toBeEnabled();
    expect(assign).not.toHaveBeenCalled();
  });
});
