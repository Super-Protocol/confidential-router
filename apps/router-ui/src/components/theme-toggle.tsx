'use client';

import { Button } from '@confidential-router/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@confidential-router/ui/components/dropdown-menu';
import { ACCENTS, type Accent, useAccent, useTheme } from '@confidential-router/ui/components/theme-provider';
import { Monitor, Moon, Palette, Sun } from 'lucide-react';
import * as React from 'react';

const ACCENT_SWATCH: Record<string, string> = {
  indigo: 'oklch(0.62 0.19 264)',
  emerald: 'oklch(0.72 0.17 162)',
  lime: 'oklch(0.85 0.2 118)',
  violet: 'oklch(0.62 0.2 300)',
};

/** Appearance menu: light / dark / system, plus the four curated accents. */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const { accent, setAccent } = useAccent();
  const [mounted, setMounted] = React.useState(false);

  // `theme` is unknown until the client has read localStorage. Rendering the
  // resolved icon before then produces a hydration mismatch.
  React.useEffect(() => setMounted(true), []);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Appearance">
          {mounted && theme === 'light' ? (
            <Sun className="size-4" aria-hidden="true" />
          ) : (
            <Moon className="size-4" aria-hidden="true" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={mounted ? theme : undefined} onValueChange={setTheme}>
          <DropdownMenuRadioItem value="light">
            <Sun className="size-4" aria-hidden="true" /> Light
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">
            <Moon className="size-4" aria-hidden="true" /> Dark
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">
            <Monitor className="size-4" aria-hidden="true" /> System
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="flex items-center gap-2">
          <Palette className="size-3.5" aria-hidden="true" /> Accent
        </DropdownMenuLabel>
        {/* A radio group, not menu items: "which accent is on" is exactly what
            `aria-checked` conveys, and it needs no extra label to say so. */}
        <DropdownMenuRadioGroup value={accent} onValueChange={(value) => setAccent(value as Accent)}>
          {ACCENTS.map((option) => (
            <DropdownMenuRadioItem key={option} value={option} className="capitalize">
              <span
                className="size-3 rounded-full border border-border"
                style={{ backgroundColor: ACCENT_SWATCH[option] }}
                aria-hidden="true"
              />
              {option}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
