import { ThemeProvider } from '@confidential-router/ui/components/theme-provider';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ThemeToggle } from './theme-toggle';

describe('ThemeToggle', () => {
  it('offers light, dark and system — and no accent choice', async () => {
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Appearance' }));

    const options = await screen.findAllByRole('menuitemradio');
    expect(options.map((option) => option.textContent?.trim())).toEqual(['Light', 'Dark', 'System']);
    expect(screen.queryByText('Accent')).not.toBeInTheDocument();
    expect(screen.queryByText(/indigo|emerald|lime|violet/i)).not.toBeInTheDocument();
  });

  it('still switches the theme', async () => {
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Appearance' }));
    await userEvent.click(await screen.findByRole('menuitemradio', { name: 'Light' }));

    expect(window.localStorage.getItem('theme')).toBe('light');
  });
});
