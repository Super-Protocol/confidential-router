# `@confidential-router/ui`

Design tokens and shared React components for the Confidential Router console
(`apps/router-ui`). Source-only: there is no build step — consumers import the
`.tsx` directly and transpile it themselves (`transpilePackages` in Next).

## Tokens

`src/styles/globals.css` is the single source of truth. It is ported from
swarm-cloud's `libs/ui/src/styles/globals.css` and reconciled with the
`Swarm Router.dc.html` prototype:

- oklch neutral scale, `--radius: 0.625rem`, Geist / Geist Mono.
- **Dark by default**, light fully supported. `next-themes` toggles `.dark` on
  `<html>`.
- Cards sit one step off the page background in dark mode (`0.185` vs `0.145`)
  so a surface reads without a shadow.
- `--brand*` is the accent, separate from `--primary`. Four curated accents —
  `indigo` (default), `emerald`, `lime`, `violet` — are selected with
  `data-accent` on `<html>`; see `ThemeProvider` / `accentScript`.
- `--brand-emphasis` is the accent tone that is legible *as text* on
  `--brand-muted`; `--brand` itself is a fill colour. Using the fill colour for
  text is the usual way an accent fails contrast.

## Imports

Subpath exports mirror the source tree:

```ts
import { Button } from '@confidential-router/ui/components/button';
import { BarChart } from '@confidential-router/ui/components/charts/bar-chart';
import { cn } from '@confidential-router/ui/lib/utils';
import '@confidential-router/ui/styles/globals.css';
```

## Components

`avatar`, `badge`, `breadcrumb`, `button`, `card`, `dialog`, `dropdown-menu`,
`input`, `label`, `select`, `sheet`, `skeleton`, `sonner` (toast), `table` and
`tabs` are shadcn/ui primitives ported from swarm-cloud (see the repository
NOTICE). The set is what the console uses today — port the next one from
swarm-cloud when a screen needs it rather than stocking the shelf. Deviations are documented in the file header —
currently a `brand` button variant and `success`/`warning`/`brand` badge
variants.

`code-block`, `copy-button`, `empty-state`, `error-state` and `theme-provider`
are this repository's own. `CopyButton` carries a lot of the console: every long
value it shows — evidence digests, the compact JWS, key prefixes — is truncated
for display and therefore only useful if the whole thing can be copied. The
button's own accessible name reports the outcome, including a clipboard the
browser refused.

### Charts

`components/charts/{bar-chart,sparkline,heatmap}` are dependency-free SVG/CSS
primitives matching the prototype. Each takes a **required** `label`, because a
chart built from `<div>`s is otherwise invisible to a screen reader; `BarChart`
and `Heatmap` additionally emit their data as an `sr-only` table.

Anything richer (axes, legends, tooltips) belongs to the screen that needs it —
see SUP-80.

## Testing

`pnpm nx test ui` — vitest + jsdom + Testing Library.
