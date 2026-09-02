import type { MockLink } from '@apollo/client/testing';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithApollo } from '../../test-utils';
import { SIGN_IN_OPTIONS_QUERY } from './operations';
import { SignUpForm } from './sign-up-form';

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

describe('SignUpForm', () => {
  it('creates the account and lands on the console, with no mail in between', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ user: { id: 'user-1' } }));
    renderForm();

    await userEvent.type(await screen.findByLabelText('Name (optional)'), 'Dev Eloper');
    await fillIn();
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/auth\/sign-up\/email$/);
    expect(JSON.parse(init.body)).toMatchObject({
      email: 'dev@example.com',
      password: 'correct-horse-battery',
      name: 'Dev Eloper',
    });
    expect(init.credentials).toBe('include');
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/'));
  });

  it('sends an empty name rather than refusing to submit without one', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    renderForm();

    await fillIn();
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).name).toBe('');
  });

  it('never puts the password in the URL', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    renderForm();

    await fillIn();
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));

    expect(fetchMock.mock.calls[0][0]).not.toContain('correct-horse-battery');
    await waitFor(() => expect(assign).toHaveBeenCalled());
    expect(assign.mock.calls[0][0]).not.toContain('correct-horse-battery');
  });

  it('states the deployment’s own minimum, and holds the button to it', async () => {
    renderForm([optionsMock({ passwordMinLength: 20 })]);

    expect(await screen.findByText(/At least 20 characters/)).toBeInTheDocument();
    await fillIn('nineteen-chars-abc');
    expect(screen.getByRole('button', { name: 'Create account' })).toBeDisabled();

    await userEvent.type(screen.getByLabelText('Password'), 'defg');
    expect(screen.getByRole('button', { name: 'Create account' })).toBeEnabled();
  });

  it('points a taken address at sign-in instead of restating the error', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: 'User already exists. Use another email.' }, false, 422));
    renderForm();

    await fillIn();
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('already exists for that address');
    expect(assign).not.toHaveBeenCalled();
  });

  it('reports an unreachable API rather than hanging on "Creating…"', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    renderForm();

    await fillIn();
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach the API');
    expect(screen.getByRole('button', { name: 'Create account' })).toBeEnabled();
  });

  it('says so, and offers the way back, on a deployment with no password provider', async () => {
    renderForm([optionsMock({ password: false })]);

    expect(await screen.findByText(/does not offer password sign-up/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to sign in' })).toHaveAttribute('href', '/login');
  });

  it('offers no form when the query fails — there is nothing here to fall back to', async () => {
    renderForm([{ request: { query: SIGN_IN_OPTIONS_QUERY }, error: new Error('API is down') }]);

    expect(await screen.findByText(/does not offer password sign-up/)).toBeInTheDocument();
  });

  it('renders no form until the answer arrives', () => {
    renderForm();

    expect(screen.getByTestId('sign-up-options-loading')).toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
  });
});
