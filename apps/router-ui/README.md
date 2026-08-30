# `router-ui`

The Confidential Router console: Next.js 16 App Router, React 19, Tailwind 4 and
the shared primitives in [`@confidential-router/ui`](../../libs/ui).

```bash
pnpm ui:dev                                            # http://localhost:3001
pnpm nx run @confidential-router/router-ui:build
pnpm nx run @confidential-router/router-ui:test        # vitest + Testing Library
pnpm nx run @confidential-router/router-ui-e2e:e2e     # Playwright smoke + axe audit
pnpm nx run @confidential-router/router-ui:codegen     # regenerate the GraphQL client
```

Configuration is three `NEXT_PUBLIC_*` variables — see [`.env.example`](./.env.example).
They are inlined at build time, so a container image is bound to one API origin.

## Routes

`(console)` holds the nine screens from the prototype; `(auth)` holds the
signed-out shell. The route groups exist so the two never share a layout: the
console layout mounts `SessionProvider`, and there is no session to fetch on the
sign-in screen.

| Route                                       | Owner   |
| ------------------------------------------- | ------- |
| `/`                                         | SUP-78 (metrics) |
| `/models`                                   | SUP-78  |
| `/keys`, `/gatekeeper`                      | SUP-79  |
| `/activity`, `/logs`                        | SUP-80  |
| `/credits`, `/profile`, `/preferences`      | SUP-81  |
| `/login`                                    | this issue |
| `/dev/components`                           | this issue |

The screens above render a placeholder naming the issue that builds them. The
shell, tokens, data layer and tests they sit on are complete.

`src/components/navigation.ts` is the single source of truth for the nine
screens: the sidebar, the breadcrumb trail and the placeholder copy all read it.

## Session handling

Sign-in is Better Auth on router-api (ADR-004): OAuth (GitHub / Google) and an
emailed magic link, no passwords. `src/lib/auth.ts` posts to `<api>/auth/*`;
the API sets an HttpOnly `cr_session` cookie on its own origin, so every request
from the console goes out with `credentials: 'include'`.

Two layers, doing different jobs:

- `src/proxy.ts` (Next 16's name for middleware) checks only that the cookie is
  **present**, and redirects accordingly. It is a routing convenience, not an
  authorisation boundary — the cookie is opaque and only router-api can say
  whether it names a live session.
- `SessionProvider` runs the `Session` query. If it comes back unauthenticated —
  which is how a session that expired mid-visit shows up — the viewer is sent to
  `/login`.

## GraphQL

`graphql/schema.graphql` is an **interim copy** of the contract in
`docs/contracts/console-graphql.md`, mechanically adjusted so it is executable
(the contract's first `extend type Mutation` becomes `type Mutation`). Codegen
runs against that file rather than a live server, so `codegen` works in CI and
on a laptop with nothing started.

`@graphql-codegen/client-preset` emits typed document nodes into
`src/generated/`, consumed directly by Apollo Client 4's `useQuery`. Never edit
that directory by hand — change the `graphql(...)` document next to the
component and re-run codegen.

> **Open item for SUP-76.** The contract names the root field `viewer` and the
> workspace balance `balance`; the router-api foundation branch (SUP-70)
> currently implements `me` and `balanceMicros`. This app is written against the
> contract. SUP-76 owns reconciling the two — either the resolvers match the
> contract, or the contract and this client change together.

## Theming

Dark by default, light fully supported, plus the four curated accents from the
prototype. `next-themes` toggles `.dark` on `<html>`; the accent is a
`data-accent` attribute set before first paint by the inline `accentScript`, so
the page never paints once in the wrong accent. Both are in the header's
Appearance menu, and `/dev/components` renders every primitive under whichever
combination is selected.

## Testing

- `src/**/*.spec.{ts,tsx}` — vitest + Testing Library over the shell, the
  navigation model, the sign-in form, the proxy redirects and the money
  formatting.
- `apps/router-ui-e2e` — Playwright against a production build: the signed-out
  redirect, both sign-in paths, the signed-in landing, in-console navigation,
  and an axe audit of the shell (dark and light), the sign-in screen, the
  gallery and the mobile drawer.
