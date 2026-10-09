'use client';

import { ThemeProvider as NextThemesProvider, useTheme } from 'next-themes';
import * as React from 'react';

/**
 * Up to 0.16.1 the console let a user pick one of four mockup accents and kept
 * the choice under this key. The brand accent is now fixed (indigo, in
 * `globals.css`); the stale value is removed so it cannot outlive the feature.
 */
export const LEGACY_ACCENT_STORAGE_KEY = 'cr-accent';

export function purgeLegacyAccent(): void {
  try {
    window.localStorage.removeItem(LEGACY_ACCENT_STORAGE_KEY);
  } catch {
    // Storage can be unavailable (privacy mode, sandboxed frame); nothing to purge then.
  }
  delete document.documentElement.dataset.accent;
}

export interface ThemeProviderProps {
  children: React.ReactNode;
  /** Dark by default (ADR-free product decision: the prototype is a dark console). */
  defaultTheme?: string;
}

export function ThemeProvider({ children, defaultTheme = 'dark' }: ThemeProviderProps) {
  React.useEffect(purgeLegacyAccent, []);

  return (
    <NextThemesProvider attribute="class" defaultTheme={defaultTheme} enableSystem disableTransitionOnChange>
      {children}
    </NextThemesProvider>
  );
}

export { useTheme };
