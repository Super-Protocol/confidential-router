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

| Route                                       | Owner   | State |
| ------------------------------------------- | ------- | ----- |
| `/`, `/models`                              | SUP-78  | built |
| `/keys`, `/gatekeeper`                      | SUP-79  | built |
| `/activity`, `/logs`                        | SUP-80  | placeholder |
| `/credits`, `/profile`, `/preferences`      | SUP-81  | placeholder |
| `/login`, `/dev/components`                 | SUP-77  | built |

A placeholder screen names the issue that builds it. The shell, tokens, data
layer and tests they sit on are complete.

`src/components/navigation.ts` is the single source of truth for the nine
screens: the sidebar, the breadcrumb trail and the placeholder copy all read it.

## Evidence

`src/components/evidence/` is the one place the console renders what an endpoint
published, and every screen that shows an endpoint uses it:

- `EvidenceBadge` — the publication state as a badge, and the way into the modal.
  Give it an `EndpointEvidenceFields` fragment and, where the screen owns a
  query, an `onRefreshed` that refetches it.
- `EvidenceModal` — platform, quote format and age, enclave image, measurement
  registers, the certificate chain, **Copy evidence JWS** and **Fetch fresh
  quote** (`refreshEvidence`, a re-poll of what the platform publishes).
- `evidence-state.ts` — the strings for `PUBLISHED` / `STALE` / `NOT_PUBLISHED`.

The vocabulary is fixed by ADR-002: the router publishes evidence and never
learns whether anyone verified it, so nothing in this directory may say
*verified*, *valid* or *trusted*. The chain is described as terminating at a
named root; whether that root is trusted is a fact about the viewer's gatekeeper,
which this console has never seen. `STALE` is the prototype's "signing key
rotating" state — a bundle exists but is outside the freshness window.

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

Codegen runs against [`apps/router-api/schema.graphql`](../router-api/schema.graphql) — the SDL
router-api emits from its code-first resolvers, committed and checked on every CI run against both the
resolver metadata and the schema the running application serves. Typing the client against that file is
therefore typing it against the deployed server, and `codegen` still works in CI and on a laptop with
nothing started.

```bash
pnpm nx run @confidential-router/router-api:schema   # regenerate the SDL, after changing a resolver
pnpm nx run @confidential-router/router-ui:codegen   # regenerate this client from it
```

`@graphql-codegen/client-preset` emits typed document nodes into `src/generated/`, consumed directly by
Apollo Client 4's `useQuery`. Never edit that directory by hand — change the `graphql(...)` document next
to the component and re-run codegen. CI regenerates it and fails on any diff.

Money crosses the wire as a `String` of integer micro-USD (`balanceMicros`, `spendMicros`, …), never a
custom scalar — see `docs/contracts/console-graphql.md`. `src/lib/format.ts` parses it as a `bigint`.
