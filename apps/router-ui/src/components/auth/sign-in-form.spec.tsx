import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as unknown as Response;
}

describe('SignInForm', () => {
  it('offers both providers and the magic link', () => {
    render(<SignInForm />);

    expect(screen.getByRole('button', { name: /Continue with GitHub/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Continue with Google/ })).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
  });

  it('keeps the magic-link button disabled until an address is typed', async () => {
    render(<SignInForm />);
    const submit = screen.getByRole('button', { name: 'Email me a link' });

    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Email'), 'dev@example.com');
    expect(submit).toBeEnabled();
  });

  it('sends the address to the magic-link endpoint and confirms', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    render(<SignInForm />);

    await userEvent.type(screen.getByLabelText('Email'), 'dev@example.com');
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
    render(<SignInForm />);

    await userEvent.type(screen.getByLabelText('Email'), 'dev@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Email me a link' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Use a different address' }));

    expect(screen.getByLabelText('Email')).toBeInTheDocument();
  });

  it('navigates to the provider authorize URL', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ url: 'https://github.com/login/oauth/authorize?x=1' }));
    render(<SignInForm />);

    await userEvent.click(screen.getByRole('button', { name: /Continue with GitHub/ }));

    expect(assign).toHaveBeenCalledWith('https://github.com/login/oauth/authorize?x=1');
  });

  it('says so when a provider is not configured, instead of navigating nowhere', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    render(<SignInForm />);

    await userEvent.click(screen.getByRole('button', { name: /Continue with Google/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('google sign-in is not configured');
    expect(assign).not.toHaveBeenCalled();
  });

  it('reports an unreachable API rather than hanging on "Sending…"', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<SignInForm />);

    await userEvent.type(screen.getByLabelText('Email'), 'dev@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Email me a link' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach the API');
    expect(screen.getByRole('button', { name: 'Email me a link' })).toBeEnabled();
  });

  it('does not render a server error message verbatim when the response is not JSON', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => Promise.reject(new Error('nope')),
    } as unknown as Response);
    render(<SignInForm />);

    await userEvent.type(screen.getByLabelText('Email'), 'dev@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Email me a link' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Sign-in failed. Please try again.');
  });
});
