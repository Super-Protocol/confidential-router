import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Holds every brand pairing to a contrast floor, read out of `globals.css`
 * itself so a token edit cannot drift past WCAG AA unnoticed (SUP-414).
 *
 * SUP-296's `color-contrast` failure on the Import button was blamed on this
 * token; measuring it said otherwise — the settled brand button is 5.28:1 in
 * both themes, and what CI sampled was the `disabled:opacity-50` fade, which
 * is 1.99:1 half-way through and no token can rescue. The audit did find two
 * pairings that really were short, and this is where the numbers now live.
 *
 * The maths mirrors axe-core: quantise to 8-bit sRGB first (that is what a
 * browser hands the checker), then WCAG 2.x relative luminance. Ratios agree
 * with axe-core 4.13.0 under Chromium 151 to the second decimal.
 */

/** WCAG AA: 4.5:1 for body text, 3:1 for large text and non-text graphics. */
const AA_TEXT = 4.5;
const AA_NON_TEXT = 3;
/** The margin a token has to keep so a renderer's rounding cannot tip it. */
const HEADROOM = 1.1;

const CSS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'globals.css'), 'utf8');

/** The `:root` (light) and `.dark` blocks, so a token can be read per theme. */
function themeBlock(selector: string): string {
  const start = CSS.indexOf(`${selector} {`);
  expect(start, `${selector} block`).toBeGreaterThan(-1);
  return CSS.slice(start, CSS.indexOf('\n}', start));
}

const BLOCKS = { light: themeBlock(':root'), dark: themeBlock('.dark') };

function token(theme: 'light' | 'dark', name: string): [number, number, number] {
  const match = new RegExp(`--${name}:\\s*oklch\\(([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)\\)`).exec(BLOCKS[theme]);
  expect(match, `--${name} in ${theme}`).not.toBeNull();
  const [, l, c, h] = match as RegExpExecArray;
  return [Number(l), Number(c), Number(h)];
}

/** OKLCH → linear sRGB (Björn Ottosson's matrices, as CSS Color 4 defines them). */
function linearSrgb([l, c, hDeg]: [number, number, number]): [number, number, number] {
  const h = (hDeg * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);
  const long = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const medium = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const short = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * long - 3.3077115913 * medium + 0.2309699292 * short,
    -1.2684380046 * long + 2.6097574011 * medium - 0.3413193965 * short,
    -0.0041960863 * long - 0.7034186147 * medium + 1.707614701 * short,
  ];
}

/** Relative luminance of the 8-bit colour a browser actually paints. */
function luminance(colour: [number, number, number]): number {
  const channels = linearSrgb(colour).map((value) => {
    const clamped = Math.min(1, Math.max(0, value));
    const encoded = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
    const quantised = Math.round(encoded * 255) / 255;
    return quantised <= 0.04045 ? quantised / 12.92 : ((quantised + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (channels[0] as number) + 0.7152 * (channels[1] as number) + 0.0722 * (channels[2] as number);
}

function ratio(a: [number, number, number], b: [number, number, number]): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return Math.floor(((high + 0.05) / (low + 0.05)) * 100) / 100;
}

describe.each(['light', 'dark'] as const)('the brand accent in %s mode', (theme) => {
  const of = (name: string) => token(theme, name);

  it('carries its own label on a brand button with headroom over AA', () => {
    // 5.28:1 — the state SUP-296's CI failure was wrongly attributed to.
    expect(ratio(of('brand-foreground'), of('brand'))).toBeGreaterThanOrEqual(AA_TEXT * HEADROOM);
  });

  it('keeps that label readable while the button is hovered', () => {
    // bg-brand/90 over the dark card was exactly 4.50:1; the opaque token is 6.21:1.
    expect(ratio(of('brand-foreground'), of('brand-hover'))).toBeGreaterThanOrEqual(AA_TEXT * HEADROOM);
  });

  it('paints accent text as --brand-emphasis, which clears AA on a card', () => {
    // --brand itself is 3.74:1 on the light card: text has to use the emphasis token.
    expect(ratio(of('brand-emphasis'), of('card'))).toBeGreaterThanOrEqual(AA_TEXT * HEADROOM);
  });

  it('keeps a brand badge readable on its own muted fill', () => {
    expect(ratio(of('brand-emphasis'), of('brand-muted'))).toBeGreaterThanOrEqual(AA_TEXT * HEADROOM);
  });

  it('still clears the non-text bar where --brand draws a graphic on a card', () => {
    // Sparklines, the passed-check tick and the border of a focused preset.
    expect(ratio(of('brand'), of('card'))).toBeGreaterThanOrEqual(AA_NON_TEXT);
  });
});

describe('the measured ratios', () => {
  it('are what the comment in globals.css claims', () => {
    expect({
      restingLight: ratio(token('light', 'brand-foreground'), token('light', 'brand')),
      restingDark: ratio(token('dark', 'brand-foreground'), token('dark', 'brand')),
      hoverLight: ratio(token('light', 'brand-foreground'), token('light', 'brand-hover')),
      hoverDark: ratio(token('dark', 'brand-foreground'), token('dark', 'brand-hover')),
      brandAsTextOnLightCard: ratio(token('light', 'brand'), token('light', 'card')),
      emphasisOnLightCard: ratio(token('light', 'brand-emphasis'), token('light', 'card')),
    }).toEqual({
      restingLight: 5.28,
      restingDark: 5.28,
      hoverLight: 6.21,
      hoverDark: 6.21,
      brandAsTextOnLightCard: 3.74,
      emphasisOnLightCard: 7.8,
    });
  });
});
