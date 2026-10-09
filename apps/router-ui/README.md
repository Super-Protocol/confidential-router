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

## Configuration

Four variables, all optional, all read from the environment **on every request**
— see [`.env.example`](./.env.example). `ROUTER_UI_API_ORIGIN` is the one a
deployment normally sets; `ROUTER_UI_GRAPHQL_HTTP` and
`ROUTER_UI_AUTH_CALLBACK_URL` default from it. `ROUTER_UI_SWARM_ROOT_PEM_URL`
is the only value the console cannot derive from its own origin — the Gatekeeper
setup block prints it in a `trust roots add` line, and a trust anchor served by
the endpoint it vouches for would prove nothing — so it defaults to where Super
Protocol publishes the Swarm CA.

They used to be `NEXT_PUBLIC_*`, which `next build` inlines into the client
bundle — one image, one API origin, and a new origin meant a new image. A
marketplace listing cannot work that way: it pins the image by digest so the
deployment's evidence stays computable from the definition, and the customer
still picks their own hostname. So the values moved to run time (SUP-100):

- `src/lib/public-config.ts` resolves them and emits an inline script;
- the root layout is `force-dynamic` and writes that script into `<head>`, ahead
  of every bundle, so a prerender cannot bake in the build host's environment;
- `publicConfig()` reads it lazily at each use — assigning the result to a module
  constant would re-create the old binding one layer down.

`apps/router-ui-e2e/playwright.image.config.ts` is what holds this: two
containers from one image, two origins, and the browser has to call each.

## Routes

`(console)` holds the ten console screens; `(auth)` holds the
signed-out shell. The route groups exist so the two never share a layout: the
console layout mounts `SessionProvider`, and there is no session to fetch on the
sign-in screen.

| Route                                       | Owner   | State |
| ------------------------------------------- | ------- | ----- |
| `/`, `/models`                              | SUP-78  | built |
| `/keys` (with “How to connect”; `/gatekeeper` redirects there) | SUP-79  | built |
| `/activity`, `/logs`                        | SUP-80  | built |
| `/credits`, `/profile`, `/preferences`      | SUP-81  | built |
| `/chat`                                     | SUP-180 | built |
| `/login`, `/dev/components`                 | SUP-77  | built |

A placeholder screen names the issue that builds it. The shell, tokens, data
layer and tests they sit on are complete.

### Account screens (SUP-81)

`/credits`, `/profile` and `/preferences` are the account group.

- **Credits** — `creditBalance` + `creditTransactions`, top-ups through Stripe
  Checkout (`createCheckout`) and automatic top-up (`setAutoTopUp`). The screen
  never writes credit: a checkout returns to `/credits?topup=success|cancelled`,
  which only refetches, because the money is real when Stripe's webhook says so.
  There is no crypto option — ADR-005 closed that.
- **Profile** — `me` plus a week of `activitySeries`, `usageByModel` and the
  `signedResponseDays` heatmap. A square means the endpoint had published
  evidence when the generation was served: publication, never a verdict
  (ADR-002).
- **Preferences** — `me { preferences }` and `updatePreferences`, plus
  `exportEvidence`, which mints a signed 15-minute link to the auditor's zip.
  Every control writes on change; there is no Save button, because
  `updatePreferences` updates only the settings it is given.

Two mutation results carry no id (`CreditBalance`, `UserPreferences`), so Apollo
cannot normalise them; both call sites write the result into the screen's query
with `cache.updateQuery`. Without that a saved setting snaps back to the cached
value on the next render.

### Activity and Logs (SUP-80)

`/activity` and `/logs` hang off one 24h / 7d / 30d range toggle
(`src/lib/ranges.ts`); Activity draws `activitySummary`, `activitySeries`,
`topKeys` and a fixed-30-day `usageByModel`, Logs paginates `generations` by
cursor and links the CSV export, which is a REST endpoint on router-api rather
than a GraphQL field.

`src/components/navigation.ts` is the single source of truth for the console
screens: the sidebar, the breadcrumb trail and the placeholder copy all read it.

### Chat (SUP-180)

`/chat` is the demo surface for someone who will not install Gatekeeper, and it
is the one screen that sends a request to `/v1` from the browser. The whole
design, and why each tier says what it says, is ADR-007; what lives where:

- `chat-stream.ts` — `POST /v1/chat/completions` with `stream: true` and the key
  `chatCredential` minted. The same gateway, guard, meter and billing as any API
  client; there is no console-only inference route, and adding one would break
  the claim the screen makes.
- `chat-history.ts` — what is left on this side now that the transcript is
  server-side: `promptMessages`, which decides the turns the next request
  carries, and the shape of the answer that is still arriving and is therefore
  not a stored message yet. The transcript's own rules — titles, the two caps,
  pruning, hard delete, one member's threads never appearing in another's list —
  are `router-api`'s, tested against a real schema in
  `app/chat/chat.service.spec.ts`.
- `verification/evidence-gate.ts` — **tier 1**. Runs the stages of
  `@confidential-router/attestation` in the page and locks the composer until
  they pass. It calls the stages individually rather than `verifyHostname`,
  because a page served by the deployment under test has no independent trust
  store to answer "is this root one of ours" with.
- `verification/sp-vm-registry.ts` — which is why the root question goes to
  Super Protocol's signed measurement registry instead, under a key pinned here
  and byte-identical to the one the Go gatekeeper pins. Keep the two in step.
- `verification/extension-bridge.ts` — **tier 2**, a tiny versioned
  `postMessage` protocol, feature-detected. The extension half is a swarm-cloud
  change; until it ships every browser reports "no extension detected", which is
  a true statement and blocks nothing. A verdict is accepted on `event.source`
  being the window the request went into — the payload's own fields are all
  copyable, and this is the only tier that says "independently".
- `verification/tiers.ts` — **every user-visible claim about verification**, in
  one file, each label paired with the caveat that has to travel with it. No
  component writes its own. Tier 3 reuses `gatekeeper/setup-commands.ts` with the
  hostname and digest filled in.

The verifier is Web Crypto from end to end, so **the chat needs a secure
origin**: HTTPS, or `http://localhost`. On a named http origin the browser
withholds `crypto.subtle`, the gate answers that first — before fetching
anything — and the composer stays locked with a message naming the fix rather
than blaming the deployment's certificate chain. That is why the e2e suite, which
serves a named http origin deliberately, tests the refusal and leaves the happy
path to the component tests.

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
*verified*, *valid* or *trusted*. `components/chat/verification/` is not an
exception to that rule but an application of it: there the *browser* is the one
checking, and each tier's label names which agent reached the verdict. The chain is described as terminating at a
named root; whether that root is trusted is a fact about the viewer's gatekeeper,
which this console has never seen. `STALE` is the prototype's "signing key
rotating" state — a bundle exists but is outside the freshness window.

## Session handling

Sign-in is Better Auth on router-api (ADR-004): OAuth (GitHub / Google), an
emailed magic link, a password, and the one-shot bootstrap token. `src/lib/auth.ts`
posts to `<api>/auth/*`; the API sets an HttpOnly session cookie **on its own
origin**, so every request from the console goes out with `credentials: 'include'`.

That cookie is invisible here. A deployment puts the console and the API on
different hostnames, cookies are keyed by host, and over https Better Auth
prefixes the name — so the console has to keep its own marker to route on
(`src/lib/signed-in-cookie.ts`, SUP-113):

- `src/lib/auth.ts` raises `cr_signed_in` on the console's host when a sign-in
  the console performed succeeds, and clears it on sign-out.
- `src/proxy.ts` (Next 16's name for middleware) checks only that the marker is
  **present**, and redirects accordingly. It is a routing convenience, not an
  authorisation boundary — the marker is a browser's claim about itself, and only
  router-api can say whether there is a session.
- `SessionProvider` and the root Apollo error handler clear the marker on the
  first unauthenticated answer — which is how a session that expired mid-visit
  shows up — and send the viewer to `/login`.
- `<ResumeSession />` on the sign-in screen covers the other direction: a magic
  link and an OAuth callback come back as a redirect from router-api, so nothing
  raised the marker. It asks the API, raises the marker, and forwards to `?next=`
  or the configured callback.

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
