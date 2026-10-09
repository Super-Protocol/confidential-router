import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { LEGACY_ACCENT_STORAGE_KEY, ThemeProvider } from './theme-provider';

describe('ThemeProvider', () => {
  beforeAll(() => {
    // next-themes reads the system preference; jsdom has no matchMedia.
    window.matchMedia ??= vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    }));
  });

  afterEach(() => {
    window.localStorage.clear();
    delete document.documentElement.dataset.accent;
  });

  it('purges an accent saved by a console that still had the switcher', () => {
    window.localStorage.setItem(LEGACY_ACCENT_STORAGE_KEY, 'lime');
    window.localStorage.setItem('theme', 'light');
    document.documentElement.dataset.accent = 'lime';

    render(
      <ThemeProvider>
        <p>console</p>
      </ThemeProvider>,
    );

    expect(screen.getByText('console')).toBeInTheDocument();
    expect(window.localStorage.getItem(LEGACY_ACCENT_STORAGE_KEY)).toBeNull();
    expect(document.documentElement.dataset.accent).toBeUndefined();
    // The theme preference is a live setting and stays.
    expect(window.localStorage.getItem('theme')).toBe('light');
  });

  it('ships one accent: the stylesheet has no per-accent overrides left', () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../styles/globals.css'), 'utf8');

    expect(css).not.toMatch(/data-accent/);
    expect(css).toContain('--brand: oklch(0.62 0.19 264);');
  });
});
