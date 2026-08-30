'use client';

import { ThemeProvider as NextThemesProvider, useTheme } from 'next-themes';
import * as React from 'react';

/** The four curated accents from the prototype; `indigo` is the default. */
export const ACCENTS = ['indigo', 'emerald', 'lime', 'violet'] as const;
export type Accent = (typeof ACCENTS)[number];

export const DEFAULT_ACCENT: Accent = 'indigo';

const ACCENT_STORAGE_KEY = 'cr-accent';

function isAccent(value: string | null): value is Accent {
  return value !== null && (ACCENTS as readonly string[]).includes(value);
}

interface AccentContextValue {
  accent: Accent;
  setAccent: (accent: Accent) => void;
}

const AccentContext = React.createContext<AccentContextValue>({
  accent: DEFAULT_ACCENT,
  setAccent: () => undefined,
});

export function useAccent(): AccentContextValue {
  return React.useContext(AccentContext);
}

/**
 * Accent lives in a `data-accent` attribute on <html> rather than in a class,
 * so it composes with next-themes' `class` strategy for light/dark instead of
 * competing with it.
 *
 * The attribute is applied by the inline script in the document head *before*
 * paint (see `accentScript`); this effect only keeps it in sync afterwards.
 */
function AccentProvider({ children }: { children: React.ReactNode }) {
  const [accent, setAccentState] = React.useState<Accent>(DEFAULT_ACCENT);

  React.useEffect(() => {
    const stored = window.localStorage.getItem(ACCENT_STORAGE_KEY);
    if (isAccent(stored)) setAccentState(stored);
  }, []);

  const setAccent = React.useCallback((next: Accent) => {
    setAccentState(next);
    window.localStorage.setItem(ACCENT_STORAGE_KEY, next);
    document.documentElement.dataset.accent = next;
  }, []);

  const value = React.useMemo(() => ({ accent, setAccent }), [accent, setAccent]);

  return <AccentContext.Provider value={value}>{children}</AccentContext.Provider>;
}

/**
 * Inline this in <head> to set the accent before first paint. Without it the
 * page renders one frame in the default accent and then repaints.
 */
export const accentScript = `(function(){try{var a=localStorage.getItem('${ACCENT_STORAGE_KEY}');if(${JSON.stringify(
  ACCENTS,
)}.indexOf(a)>-1)document.documentElement.dataset.accent=a;}catch(e){}})();`;

export interface ThemeProviderProps {
  children: React.ReactNode;
  /** Dark by default (ADR-free product decision: the prototype is a dark console). */
  defaultTheme?: string;
}

export function ThemeProvider({ children, defaultTheme = 'dark' }: ThemeProviderProps) {
  return (
    <NextThemesProvider attribute="class" defaultTheme={defaultTheme} enableSystem disableTransitionOnChange>
      <AccentProvider>{children}</AccentProvider>
    </NextThemesProvider>
  );
}

export { useTheme };
