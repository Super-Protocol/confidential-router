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
function optionsMock(
  overrides: Partial<{ password: boolean; passwordMinLength: number; inviteRequired: boolean }> = {},
) {
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
          inviteRequired: false,
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

    expect(await screen.findByTestId('sign-up-api-unreachable')).toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
  });

  // SUP-248: an API behind a 503 read as a deployment that had switched
  // passwords off, which sent people looking for a setting that was on.
  it('says the API is unreachable rather than that password sign-up is off', async () => {
    routeFetch({});
    renderForm([{ request: { query: SIGN_IN_OPTIONS_QUERY }, error: new Error('API is down') }]);

    expect(await screen.findByText(/cannot reach this deployment's API/)).toBeInTheDocument();
    expect(screen.queryByText(/does not offer password sign-up/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to sign in' })).toHaveAttribute('href', '/login');
  });

  it('offers the form once a retry reaches the API', async () => {
    routeFetch({});
    renderForm([{ request: { query: SIGN_IN_OPTIONS_QUERY }, error: new Error('API is down') }, optionsMock()]);

    await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));

    expect(await screen.findByLabelText('Password')).toBeInTheDocument();
    expect(screen.queryByTestId('sign-up-api-unreachable')).not.toBeInTheDocument();
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

/**
 * Invite-only registration (SUP-173).
 *
 * Every case here is about the same failure: the reason this deployment will not
 * create an account has to be impossible to miss. The router refuses whatever the
 * console renders, so none of this is the enforcement — it is the difference
 * between a visitor who knows to ask for a new code and one who fills the form in
 * three times.
 */
describe('a deployment where registration is by invitation', () => {
  const required = [optionsMock({ inviteRequired: true })];

  it('says so, and opens the code field without being asked', async () => {
    routeFetch({});
    renderForm(required);

    expect(await screen.findByTestId('invite-required-notice')).toHaveTextContent('Registration is by invitation');
    expect(screen.getByLabelText('Invitation code')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Have a code?' })).not.toBeInTheDocument();
  });

  it('holds the button until a code has passed the live lookup, and says why', async () => {
    routeFetch({});
    renderForm(required);

    await fillIn();
    expect(screen.getByRole('button', { name: 'Create account' })).toBeDisabled();
    expect(screen.getByTestId('sign-up-blocked-on-invite')).toHaveTextContent('working invitation code');
  });

  it('releases the button once the router confirms the code', async () => {
    vi.stubGlobal('location', { ...window.location, search: `?invite=${CODE}`, assign });
    routeFetch({ invite: { valid: true, grantMicros: GRANT_MICROS, campaign: 'launch' } });
    renderForm(required);

    await screen.findByTestId('invite-grant-pending');
    await fillIn();

    expect(screen.getByRole('button', { name: 'Create account' })).toBeEnabled();
    await submit();
    expect(bodyOf('/auth/sign-up/email').inviteCode).toBe(NORMALISED);
  });

  it('turns a code the lookup refuses into an alert, not a footnote about credit', async () => {
    vi.stubGlobal('location', { ...window.location, search: `?invite=${CODE}`, assign });
    routeFetch({ invite: { valid: false, reason: 'unavailable' } });
    renderForm(required);

    const alert = await screen.findByTestId('invite-unavailable-required');
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert).toHaveTextContent('cannot be used');
    // The old copy, which invited the visitor to carry on without the credit,
    // would be a lie here: there is no account to be had without a code.
    expect(screen.queryByTestId('invite-unavailable')).not.toBeInTheDocument();
  });

  // SUP-176. The lookup cannot say which refusal it is, so the sentence it
  // renders must not pretend to, and must not be the last word either.
  it('does not guess why the lookup refused the code', async () => {
    vi.stubGlobal('location', { ...window.location, search: `?invite=${CODE}`, assign });
    routeFetch({ invite: { valid: false, reason: 'unavailable' } });
    renderForm(required);

    const alert = await screen.findByTestId('invite-unavailable-required');
    expect(alert.textContent).not.toMatch(/may already have been claimed|mistyped/i);
    expect(alert).toHaveTextContent('already claimed or was never issued');
  });

  it('lets the form submit on a refused lookup, so the router can say which refusal it is', async () => {
    vi.stubGlobal('location', { ...window.location, search: `?invite=${CODE}`, assign });
    routeFetch({ invite: { valid: false, reason: 'unavailable' } });
    renderForm(required);

    await screen.findByTestId('invite-unavailable-required');
    await fillIn();

    // Held before SUP-176, which is what kept the typed refusal below out of
    // every browser: the submit it arrives on could never be made.
    expect(screen.getByRole('button', { name: 'Create account' })).toBeEnabled();
    expect(screen.queryByTestId('sign-up-blocked-on-invite')).not.toBeInTheDocument();

    await submit();
    expect(bodyOf('/auth/sign-up/email').inviteCode).toBe(NORMALISED);
  });

  it.each([
    ['invite_already_claimed', 'already been claimed'],
    ['invite_expired_or_unknown', 'may have expired'],
  ])('reads a spent code and an unissued one differently in the browser: %s', async (code, sentence) => {
    vi.stubGlobal('location', { ...window.location, search: `?invite=${CODE}`, assign });
    routeFetch({
      invite: { valid: false, reason: 'unavailable' },
      // Both codes look identical to the lookup; only the sign-up tells them apart.
      signUp: jsonResponse({ code, message: 'refused' }, false, 403),
    });
    renderForm(required);

    await screen.findByTestId('invite-unavailable-required');
    await fillIn();
    await submit();

    expect(await screen.findByTestId(`invite-refused-${code}`)).toHaveTextContent(sentence);
    expect(screen.queryByTestId('invite-unavailable-required')).not.toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });

  it.each(['checking', 'unknown'])('still holds the button while the code has no answer at all: %s', async (kind) => {
    vi.stubGlobal('location', { ...window.location, search: `?invite=${CODE}`, assign });
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/v1/invites/')) {
        // `checking` never settles; `unknown` settles on a transport failure.
        return kind === 'checking' ? new Promise(() => {}) : Promise.reject(new Error('offline'));
      }
      return Promise.resolve(jsonResponse({}, true, 202));
    });
    renderForm(required);

    await screen.findByTestId(kind === 'checking' ? 'invite-checking' : 'invite-unknown');
    await fillIn();
    expect(screen.getByRole('button', { name: 'Create account' })).toBeDisabled();
    expect(callTo('/auth/sign-up/email')).toBeUndefined();
  });

  it('renders each refusal the router can answer with, distinctly', async () => {
    const seen = new Set<string>();
    for (const code of ['invite_required', 'invite_already_claimed', 'invite_expired_or_unknown']) {
      vi.stubGlobal('location', { ...window.location, search: `?error=${code}`, assign });
      routeFetch({});
      const { unmount } = renderForm(required);

      const alert = await screen.findByTestId(`invite-refused-${code}`);
      seen.add(alert.textContent ?? '');
      unmount();
    }
    expect(seen.size).toBe(3);
  });

  it('shows the refusal the sign-up itself was answered with, not a generic error', async () => {
    vi.stubGlobal('location', { ...window.location, search: `?invite=${CODE}`, assign });
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/v1/invites/')) {
        return Promise.resolve(jsonResponse({ valid: true, grantMicros: GRANT_MICROS, campaign: 'launch' }));
      }
      if (String(url).includes('/v1/analytics/events')) {
        return Promise.resolve(jsonResponse({}, true, 202));
      }
      // The race the live lookup cannot see: the last seat went while the form
      // was being filled in.
      return Promise.resolve(
        jsonResponse(
          { code: 'invite_already_claimed', message: 'This invitation has already been claimed.' },
          false,
          403,
        ),
      );
    });
    renderForm(required);

    await screen.findByTestId('invite-grant-pending');
    await fillIn();
    await submit();

    expect(await screen.findByTestId('invite-refused-invite_already_claimed')).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });

  it('clears the refusal when a different code is applied, so it does not read as a verdict on the new one', async () => {
    vi.stubGlobal('location', { ...window.location, search: '?error=invite_already_claimed', assign });
    routeFetch({ invite: { valid: true, grantMicros: GRANT_MICROS, campaign: 'launch' } });
    renderForm(required);

    await screen.findByTestId('invite-refused-invite_already_claimed');
    await userEvent.type(screen.getByLabelText('Invitation code'), CODE);
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));

    expect(await screen.findByTestId('invite-grant-pending')).toBeInTheDocument();
  });

  it('leaves an open deployment exactly as it was', async () => {
    vi.stubGlobal('location', { ...window.location, search: `?invite=${CODE}`, assign });
    routeFetch({ invite: { valid: false, reason: 'unavailable' } });
    renderForm();

    expect(await screen.findByTestId('invite-unavailable')).toHaveTextContent('still create an account');
    await fillIn();
    expect(screen.getByRole('button', { name: 'Create account' })).toBeEnabled();
  });
});
