import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodeBlock } from './code-block';
import { CopyButton } from './copy-button';

function stubClipboard(writeText: () => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('CopyButton', () => {
  it('puts the value on the clipboard and says so', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    render(<CopyButton value="sk-tee-v1-abc" label="Copy the API key" />);

    await userEvent.click(screen.getByRole('button', { name: 'Copy the API key' }));

    expect(writeText).toHaveBeenCalledWith('sk-tee-v1-abc');
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('reports a clipboard the browser refused instead of pretending it worked', async () => {
    stubClipboard(vi.fn().mockRejectedValue(new Error('denied')));
    render(<CopyButton value="anything" />);

    await userEvent.click(screen.getByRole('button', { name: 'Copy' }));

    expect(await screen.findByRole('button', { name: 'Copy failed' })).toBeInTheDocument();
  });

  it('returns to its idle label', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubClipboard(vi.fn().mockResolvedValue(undefined));
    render(<CopyButton value="x" label="Copy the digest" />);

    await userEvent.click(screen.getByRole('button', { name: 'Copy the digest' }));
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(screen.getByRole('button', { name: 'Copy the digest' })).toBeInTheDocument();
  });
});

describe('CodeBlock', () => {
  it('renders the snippet verbatim and copies exactly it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    render(<CodeBlock code={'gatekeeper init\ngatekeeper run'} title="Terminal" copyLabel="Copy the setup" />);

    expect(screen.getByText('Terminal')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Copy the setup' }));

    expect(writeText).toHaveBeenCalledWith('gatekeeper init\ngatekeeper run');
  });

  it('leaves out the copy button for a block nobody would copy', () => {
    render(<CodeBlock code="verified · router-eu" copyable={false} />);

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
