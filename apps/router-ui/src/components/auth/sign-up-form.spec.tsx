import type { MockLink } from '@apollo/client/testing';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INVITE_STORAGE_KEY } from '../../lib/invite';
import { renderWithApollo } from '../../test-utils';
import { SIGN_IN_OPTIONS_QUERY } from './operations';
import { SignUpForm } from './sign-up-form';

const fetchMock = vi.fn();
const assign = vi.fn();

const GRANT_MICROS = '100000000';
const CODE = 'ABCD-EFGH-JKLM';
const NORMALISED = 'ABCDEFGHJKLM';

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('location', { ...window.location, search: '', assign });
  fetchMock.mockReset();
  assign.mockReset();
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 400) {
  return { ok, status, json: async () => body } as unknown as Response;
}

/**
 * The form makes three kinds of request — the analytics ingest, the invitation
 * lookup and the sign-up itself — so a test that reached for `calls[0]` would be
 * asserting on whichever happened to be first. Every helper below matches on the
 * path instead.
 */
function callTo(fragment: string): [string, RequestInit] | undefined {
  return fetchMock.mock.calls.find(([url]) => String(url).includes(fragment)) as [string, RequestInit] | undefined;
}

function bodyOf(fragment: string): Record<string, unknown> {
  const call = callTo(fragment);
  expect(call, `no request to ${fragment}`).toBeDefined();
  return JSON.parse((call as [string, RequestInit])[1].body as string);
}

/** Answers each of the form's requests by path, so order does not matter. */
function routeFetch(handlers: { invite?: unknown; signUp?: Response }): void {
  fetchMock.mockImplementation((url: string) => {
    if (String(url).includes('/v1/invites/')) {
      return Promise.resolve(jsonResponse(handlers.invite ?? { valid: false, reason: 'unavailable' }));
    }
    if (String(url).includes('/v1/analytics/events')) {
      return Promise.resolve(jsonResponse({}, true, 202));
    }
    return Promise.resolve(handlers.signUp ?? jsonResponse({ user: { id: 'user-1' } }));
  });
}

/** A marketplace deployment: passwords are the only self-service way in. */
function optionsMock(overrides: Partial<{ password: boolean; passwordMinLength: number }> = {}) {
  return {
    request: { query: SIGN_IN_OPTIONS_QUERY },
    result: {
      data: {
        signInOptions: {
          __typename: 'SignInOptions',
          bootstrap: false,
          github: false,
          google: false,
          magicLink: false,
          password: true,
          passwordMinLength: 12,
          ...overrides,
        },
      },
    },
    maxUsageCount: Number.POSITIVE_INFINITY,
  } satisfies MockLink.MockedResponse;
}

function renderForm(mocks: MockLink.MockedResponse[] = [optionsMock()]) {
  return renderWithApollo(<SignUpForm />, { mocks });
}

async function fillIn(password = 'correct-horse-battery') {
  await userEvent.type(await screen.findByLabelText('Email'), 'dev@example.com');
  await userEvent.type(screen.getByLabelText('Password'), password);
}

async function submit() {
  await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
}

describe('SignUpForm', () => {
  it('creates the account and lands on the console, with no mail in between', async () => {
    routeFetch({});
    renderForm();

    await userEvent.type(await screen.findByLabelText('Name (optional)'), 'Dev Eloper');
    await fillIn();
    await submit();

    expect(bodyOf('/auth/sign-up/email')).toMatchObject({
      email: 'dev@example.com',
      password: 'correct-horse-battery',
      name: 'Dev Eloper',
    });
    expect((callTo('/auth/sign-up/email') as [string, RequestInit])[1].credentials).toBe('include');
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/'));
  });

  it('sends an empty name rather than refusing to submit without one', async () => {
    routeFetch({});
    renderForm();

    await fillIn();
    await submit();

    expect(bodyOf('/auth/sign-up/email').name).toBe('');
  });

  it('never puts the password in the URL', async () => {
    routeFetch({});
    renderForm();

    await fillIn();
    await submit();

    expect((callTo('/auth/sign-up/email') as [string, RequestInit])[0]).not.toContain('correct-horse-battery');
    await waitFor(() => expect(assign).toHaveBeenCalled());
    expect(assign.mock.calls[0][0]).not.toContain('correct-horse-battery');
  });

  it('states the deployment’s own minimum, and holds the button to it', async () => {
    routeFetch({});
    renderForm([optionsMock({ passwordMinLength: 20 })]);

    expect(await screen.findByText(/At least 20 characters/)).toBeInTheDocument();
    await fillIn('nineteen-chars-abc');
    expect(screen.getByRole('button', { name: 'Create account' })).toBeDisabled();

    await userEvent.type(screen.getByLabelText('Password'), 'defg');
    expect(screen.getByRole('button', { name: 'Create account' })).toBeEnabled();
  });

  it('points a taken address at sign-in instead of restating the error', async () => {
    routeFetch({
      signUp: jsonResponse({ message: 'User already exists. Use another email.' }, false, 422),
    });
    renderForm();

    await fillIn();
    await submit();

    expect(await screen.findByRole('alert')).toHaveTextContent('already exists for that address');
    expect(assign).not.toHaveBeenCalled();
  });

  it('reports an unreachable API rather than hanging on "Creating…"', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    renderForm();

    await fillIn();
    await submit();

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach the API');
    expect(screen.getByRole('button', { name: 'Create account' })).toBeEnabled();
  });

  it('says so, and offers the way back, on a deployment with no password provider', async () => {
    routeFetch({});
    renderForm([optionsMock({ password: false })]);

    expect(await screen.findByText(/does not offer password sign-up/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to sign in' })).toHaveAttribute('href', '/login');
  });

  it('offers no form when the query fails — there is nothing here to fall back to', async () => {
    routeFetch({});
    renderForm([{ request: { query: SIGN_IN_OPTIONS_QUERY }, error: new Error('API is down') }]);

    expect(await screen.findByText(/does not offer password sign-up/)).toBeInTheDocument();
  });

  it('renders no form until the answer arrives', () => {
    routeFetch({});
    renderForm();

    expect(screen.getByTestId('sign-up-options-loading')).toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
  });
});

describe('an invitation in the URL', () => {
  beforeEach(() => {
    vi.stubGlobal('location', { ...window.location, search: `?invite=${CODE}&utm_campaign=Launch`, assign });
  });

  it('promises the grant without asking the visitor to type anything', async () => {
    routeFetch({ invite: { valid: true, grantMicros: GRANT_MICROS, campaign: 'launch-2026-10-devs' } });
    renderForm();

    const notice = await screen.findByTestId('invite-grant-pending');
    expect(notice).toHaveTextContent('$100 in credits will be added to your account.');
    expect(notice).toHaveTextContent('launch-2026-10-devs');
    // The code is never a field the visitor fills in when the URL carried one.
    expect(screen.queryByLabelText('Invitation code')).not.toBeInTheDocument();
  });

  it('sends the code with the sign-up and lands on the Credits screen', async () => {
    routeFetch({ invite: { valid: true, grantMicros: GRANT_MICROS, campaign: 'launch' } });
    renderForm();

    await fillIn();
    await submit();

    expect(bodyOf('/auth/sign-up/email').inviteCode).toBe(NORMALISED);
    // The one thing that happened while they filled in the form was that $100
    // arrived — so the screen that shows the balance and the ledger entry.
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/credits?welcome=invite'));
  });

  it('keeps the code across the console’s own navigations', async () => {
    routeFetch({ invite: { valid: true, grantMicros: GRANT_MICROS, campaign: 'launch' } });
    renderForm();

    await screen.findByTestId('invite-grant-pending');
    expect(window.localStorage.getItem(INVITE_STORAGE_KEY)).toBe(NORMALISED);
  });

  it('reports the sign-up screen anonymously, with the campaign it can join on', async () => {
    routeFetch({ invite: { valid: true, grantMicros: GRANT_MICROS, campaign: 'launch-2026-10-devs' } });
    renderForm();

    await screen.findByTestId('invite-grant-pending');
    await waitFor(() => expect(callTo('/v1/analytics/events')).toBeDefined());
    expect(bodyOf('/v1/analytics/events')).toEqual({
      event: 'signup_started',
      properties: {
        has_invite: true,
        campaign: 'launch-2026-10-devs',
        utm_campaign: 'launch',
        // UTM parameters in the URL mean the visitor came through the landing page.
        entry: 'landing_cta',
      },
    });
  });

  it('still lets a spent code create an account, and says the credit is not coming', async () => {
    routeFetch({ invite: { valid: false, reason: 'unavailable' } });
    renderForm();

    expect(await screen.findByTestId('invite-unavailable')).toHaveTextContent('still create an account');

    await fillIn();
    await submit();

    // Sent anyway: the lookup's answer is a snapshot, and only the redemption
    // inside account creation decides anything.
    expect(bodyOf('/auth/sign-up/email').inviteCode).toBe(NORMALISED);
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/credits?welcome=invite'));
  });

  it('does not talk anyone out of signing up because the lookup was unreachable', async () => {
    fetchMock.mockImplementation((url: string) =>
      String(url).includes('/v1/invites/')
        ? Promise.reject(new TypeError('Failed to fetch'))
        : Promise.resolve(jsonResponse({ user: { id: 'user-1' } })),
    );
    renderForm();

    // "We could not check your invitation" — not "your invitation is no good".
    expect(await screen.findByTestId('invite-unknown')).toHaveTextContent('could not check your invitation');
  });
});

describe('a visitor who lost the link', () => {
  it('can paste a code, and the form then promises the grant', async () => {
    routeFetch({ invite: { valid: true, grantMicros: GRANT_MICROS, campaign: 'launch' } });
    renderForm();

    await userEvent.click(await screen.findByRole('button', { name: 'Have a code?' }));
    await userEvent.type(screen.getByLabelText('Invitation code'), 'abcd efgh jklm');
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));

    expect(await screen.findByTestId('invite-grant-pending')).toHaveTextContent('$100 in credits');
    // Normalised the way router-api stores it, so the case and the separators a
    // person types do not decide whether the code matches.
    expect(callTo('/v1/invites/')?.[0]).toContain(NORMALISED);
  });

  it('reports no invitation at all when nothing was carried and nothing was typed', async () => {
    routeFetch({});
    renderForm();

    await waitFor(() => expect(callTo('/v1/analytics/events')).toBeDefined());
    expect(bodyOf('/v1/analytics/events')).toEqual({
      event: 'signup_started',
      properties: { has_invite: false, entry: 'direct' },
    });
    expect(callTo('/v1/invites/')).toBeUndefined();
  });
});
