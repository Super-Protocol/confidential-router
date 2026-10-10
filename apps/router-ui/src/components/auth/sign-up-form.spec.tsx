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
 * The form makes four kinds of request — the analytics ingest, the invitation
 * lookup, the request for a mailed code and the sign-up that hands it back — so
 * a test that reached for `calls[0]` would be
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
function routeFetch(handlers: { invite?: unknown; send?: Response; signUp?: Response }): void {
  fetchMock.mockImplementation((url: string) => {
    if (String(url).includes('/v1/invites/')) {
      return Promise.resolve(jsonResponse(handlers.invite ?? { valid: false, reason: 'unavailable' }));
    }
    if (String(url).includes('/v1/analytics/events')) {
      return Promise.resolve(jsonResponse({}, true, 202));
    }
    if (String(url).includes(SEND)) {
      return Promise.resolve(handlers.send ?? jsonResponse({ success: true }));
    }
    return Promise.resolve(handlers.signUp ?? jsonResponse({ user: { id: 'user-1' } }));
  });
}

/** Asking for a code, and handing it back — which is what creates the account. */
const SEND = '/auth/email-otp/send-verification-otp';
const SIGN_UP = '/auth/sign-in/email-otp';
const MAILED = '123456';

/** A production deployment with a mailer: a mailed code is the self-service way in. */
function optionsMock(
  overrides: Partial<{
    emailCode: boolean;
    emailCodeLength: number;
    inviteRequired: boolean;
  }> = {},
) {
  return {
    request: { query: SIGN_IN_OPTIONS_QUERY },
    result: {
      data: {
        signInOptions: {
          __typename: 'SignInOptions',
          bootstrap: false,
          adminRecovery: false,
          github: false,
          google: false,
          emailCode: true,
          emailCodeLength: 6,
          magicLink: false,
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

/** The first step: the address the code is to be mailed to. */
async function fillIn() {
  await userEvent.type(await screen.findByLabelText('Email'), 'dev@example.com');
}

/** Asks for a code, leaving the card on its code step. */
async function askForCode() {
  await userEvent.click(screen.getByRole('button', { name: 'Email me a code' }));
  return screen.findByLabelText('Code');
}

/** Both steps: asks for a code, types the one that was "mailed", and creates the account. */
async function submit() {
  await userEvent.type(await askForCode(), MAILED);
  await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
}

describe('SignUpForm', () => {
  it('asks for an address and a name, and no password', async () => {
    routeFetch({});
    renderForm();

    expect(await screen.findByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Name (optional)')).toBeInTheDocument();
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
    // The old promise — no mail, the account works at once — is now false.
    expect(screen.queryByText(/no confirmation mail/i)).not.toBeInTheDocument();
    expect(screen.getByText(/we mail a one-time code to your address/)).toBeInTheDocument();
  });

  it('mails a code to the address before anything is created', async () => {
    routeFetch({});
    renderForm();

    await userEvent.type(await screen.findByLabelText('Name (optional)'), 'Dev Eloper');
    await fillIn();
    const field = await askForCode();

    // By address alone: the name and the invitation belong to the request that
    // creates the account, which has not been made.
    expect(bodyOf(SEND)).toEqual({ email: 'dev@example.com', type: 'sign-in' });
    expect(callTo(SIGN_UP)).toBeUndefined();
    expect(screen.getByText(/We sent a 6-digit code to/)).toHaveTextContent('dev@example.com');
    expect(field).toHaveAttribute('autocomplete', 'one-time-code');
    expect(field).toHaveAttribute('maxlength', '6');
    expect(assign).not.toHaveBeenCalled();
  });

  it('creates the account with the code and lands on the console', async () => {
    routeFetch({});
    renderForm();

    await userEvent.type(await screen.findByLabelText('Name (optional)'), 'Dev Eloper');
    await fillIn();
    await submit();

    expect(bodyOf(SIGN_UP)).toEqual({ email: 'dev@example.com', otp: MAILED, name: 'Dev Eloper' });
    expect((callTo(SIGN_UP) as [string, RequestInit])[1].credentials).toBe('include');
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/'));
  });

  it('leaves the name out rather than refusing to submit without one', async () => {
    routeFetch({});
    renderForm();

    await fillIn();
    await submit();

    expect(bodyOf(SIGN_UP)).toEqual({ email: 'dev@example.com', otp: MAILED });
  });

  it('never puts the code in the URL', async () => {
    routeFetch({});
    renderForm();

    await fillIn();
    await submit();

    expect((callTo(SIGN_UP) as [string, RequestInit])[0]).not.toContain(MAILED);
    await waitFor(() => expect(assign).toHaveBeenCalled());
    expect(assign.mock.calls[0][0]).not.toContain(MAILED);
  });

  it('holds "Create account" until the code has every digit the deployment says it has', async () => {
    routeFetch({});
    renderForm([optionsMock({ emailCodeLength: 8 })]);

    await fillIn();
    const field = await askForCode();
    await userEvent.type(field, '1234567');
    expect(screen.getByRole('button', { name: 'Create account' })).toBeDisabled();

    await userEvent.type(field, '8');
    expect(screen.getByRole('button', { name: 'Create account' })).toBeEnabled();
  });

  it('says a wrong code is wrong, and creates nothing', async () => {
    routeFetch({ signUp: jsonResponse({ code: 'INVALID_OTP', message: 'Invalid OTP' }, false, 400) });
    renderForm();

    await fillIn();
    await submit();

    expect(await screen.findByRole('alert')).toHaveTextContent('That code is not right');
    expect(assign).not.toHaveBeenCalled();
  });

  it.each(['OTP_EXPIRED', 'TOO_MANY_ATTEMPTS'])('says a dead code is dead and offers a new one: %s', async (code) => {
    routeFetch({ signUp: jsonResponse({ code, message: 'refused' }, false, 400) });
    renderForm();

    await fillIn();
    await submit();

    expect(await screen.findByRole('alert')).toHaveTextContent('That code no longer works. Send a new one.');
    expect(screen.getByLabelText('Code')).toHaveValue('');

    await userEvent.click(screen.getByRole('button', { name: 'Send a new code' }));
    expect(await screen.findByTestId('email-code-resent')).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes(SEND))).toHaveLength(2);
  });

  it('tells a throttled request for a code to wait', async () => {
    routeFetch({ send: jsonResponse({ code: 'RATE_LIMITED', message: 'Too many.' }, false, 429) });
    renderForm();

    await fillIn();
    await userEvent.click(screen.getByRole('button', { name: 'Email me a code' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Too many attempts. Wait a minute and try again.');
    expect(screen.queryByLabelText('Code')).not.toBeInTheDocument();
  });

  it('goes back for a different address, keeping what was typed', async () => {
    routeFetch({});
    renderForm();

    await userEvent.type(await screen.findByLabelText('Name (optional)'), 'Dev Eloper');
    await fillIn();
    await askForCode();
    await userEvent.click(screen.getByRole('button', { name: 'Use a different address' }));

    expect(await screen.findByLabelText('Email')).toHaveValue('dev@example.com');
    expect(screen.getByLabelText('Name (optional)')).toHaveValue('Dev Eloper');
  });

  it('reports an unreachable API rather than hanging on "Sending…"', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    renderForm();

    await fillIn();
    await userEvent.click(screen.getByRole('button', { name: 'Email me a code' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach the API');
    expect(screen.getByRole('button', { name: 'Email me a code' })).toBeEnabled();
  });

  it('says so, and offers the way back, on a deployment that cannot mail a code', async () => {
    routeFetch({});
    renderForm([optionsMock({ emailCode: false })]);

    expect(await screen.findByText(/Registration by email is not available on this deployment/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to sign in' })).toHaveAttribute('href', '/login');
  });

  it('offers no form when the query fails — there is nothing here to fall back to', async () => {
    routeFetch({});
    renderForm([{ request: { query: SIGN_IN_OPTIONS_QUERY }, error: new Error('API is down') }]);

    expect(await screen.findByTestId('sign-up-api-unreachable')).toBeInTheDocument();
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
  });

  // SUP-248: an API behind a 503 read as a deployment that had switched
  // sign-up off, which sent people looking for a setting that was on.
  it('says the API is unreachable rather than that registration is off', async () => {
    routeFetch({});
    renderForm([{ request: { query: SIGN_IN_OPTIONS_QUERY }, error: new Error('API is down') }]);

    expect(await screen.findByText(/cannot reach this deployment's API/)).toBeInTheDocument();
    expect(screen.queryByText(/Registration by email is not available/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to sign in' })).toHaveAttribute('href', '/login');
  });

  it('offers the form once a retry reaches the API', async () => {
    routeFetch({});
    renderForm([{ request: { query: SIGN_IN_OPTIONS_QUERY }, error: new Error('API is down') }, optionsMock()]);

    await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));

    expect(await screen.findByLabelText('Email')).toBeInTheDocument();
    expect(screen.queryByTestId('sign-up-api-unreachable')).not.toBeInTheDocument();
  });

  it('renders no form until the answer arrives', () => {
    routeFetch({});
    renderForm();

    expect(screen.getByTestId('sign-up-options-loading')).toBeInTheDocument();
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
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

    expect(bodyOf(SIGN_UP).inviteCode).toBe(NORMALISED);
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
    expect(bodyOf(SIGN_UP).inviteCode).toBe(NORMALISED);
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

  it('mails no code until an invitation has passed the live lookup, and says why', async () => {
    routeFetch({});
    renderForm(required);

    await fillIn();
    // Held here rather than at the code step: a mailed code is spent by being
    // checked, so a refusal after it would send the visitor back to their inbox.
    expect(screen.getByRole('button', { name: 'Email me a code' })).toBeDisabled();
    expect(screen.getByTestId('sign-up-blocked-on-invite')).toHaveTextContent('working invitation code');
    expect(callTo(SEND)).toBeUndefined();
  });

  it('releases the button once the router confirms the code', async () => {
    vi.stubGlobal('location', { ...window.location, search: `?invite=${CODE}`, assign });
    routeFetch({ invite: { valid: true, grantMicros: GRANT_MICROS, campaign: 'launch' } });
    renderForm(required);

    await screen.findByTestId('invite-grant-pending');
    await userEvent.type(screen.getByLabelText('Name (optional)'), 'Invited');
    await fillIn();

    expect(screen.getByRole('button', { name: 'Email me a code' })).toBeEnabled();
    await submit();
    expect(bodyOf(SIGN_UP)).toEqual({ email: 'dev@example.com', otp: MAILED, name: 'Invited', inviteCode: NORMALISED });
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
    expect(screen.getByRole('button', { name: 'Email me a code' })).toBeEnabled();
    expect(screen.queryByTestId('sign-up-blocked-on-invite')).not.toBeInTheDocument();

    await submit();
    expect(bodyOf(SIGN_UP).inviteCode).toBe(NORMALISED);
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
    // Back on the form, where the invitation is: the mailed code was spent by
    // the refusal, so the code step has nothing left to offer.
    expect(screen.queryByLabelText('Code')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Invitation code')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveValue('dev@example.com');
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
    expect(screen.getByRole('button', { name: 'Email me a code' })).toBeDisabled();
    expect(callTo(SEND)).toBeUndefined();
    expect(callTo(SIGN_UP)).toBeUndefined();
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
      if (String(url).includes(SEND)) {
        return Promise.resolve(jsonResponse({ success: true }));
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
    expect(screen.getByRole('button', { name: 'Email me a code' })).toBeEnabled();
  });
});
