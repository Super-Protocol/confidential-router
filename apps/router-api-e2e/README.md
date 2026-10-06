# router-api-e2e

The built `router-api`, as a process, over real HTTP.

```bash
pnpm nx run @confidential-router/router-api-e2e:e2e
```

## What this is for, and what it is not

`apps/router-api/test/*.e2e.spec.ts` boots the Nest application in process and
covers the application's logic — the gateway, the guards, the resolvers, the
metering — against a throwaway SQLite file. That is the right shape for testing
an application, and it is where most assertions belong.

What it cannot cover is the **artefact**: that `dist/main.js` starts, reads its
configuration file, applies its migrations, binds a socket, and that a real
`openai` client talking real HTTP to it gets what the SDK expects. Those are the
failures that only ever happen outside a test runner, so they are what this
project asserts and it deliberately leaves the rest alone.

| File | The boundary it crosses |
| --- | --- |
| `gateway.e2e.spec.ts` | the OpenAI SDK ↔ the built process: completions, streaming, what reaches the backend, the error table, a revoked key |
| `console.e2e.spec.ts` | the console's API ↔ the gateway: money bought on Credits is money `/v1` spends, and a metered generation is the one Activity shows |
| `evidence.e2e.spec.ts` | the evidence poller ↔ a live HTTPS publisher: retrieval, digest history, a publisher that goes away, coverage attribution |
| `bootstrap.e2e.spec.ts` | first sign-in on an empty deployment: the token must not reach the log, and the CSRF guard is only observable outside a test runner |
| `password.e2e.spec.ts` | the same two, for email and password |
| `invites.e2e.spec.ts` | `dist/cli/invites.js` ↔ the running process: a second webpack entry point can stop existing while every in-process test stays green, so the CLI mints a campaign and each URL in its CSV is resolved against the live lookup endpoint |
| `external-endpoints.e2e.spec.ts` | router-api ↔ the **real** egress sidecar ↔ an upstream in another cloud (ADR-008): the config router-api renders is a file the shipped binary accepts, an admin's trust-list edit reaches a running proxy, and a connection the gatekeeper closes mid-stream comes back as `attestation_revoked` |

The stack is `tools/demo`'s `startRouterStack()` — the same one the gatekeeper
demo runs on, so a change that breaks one breaks both. The external-endpoint
suite adds `startExternalStand()` on top of it: the upstream, the real
`gatekeeper-sidecar`, and the admin API that registers one. Its one substitution
— the attested-root hardware leg — and why it cannot be avoided are in
`tools/demo/README.md`.

## Shape

- vitest + supertest, `vitest.e2e.config.mts`. Named that rather than
  `vitest.config.mts` because the `@nx/vitest` plugin infers a `test` target
  from the latter, and this is not a unit suite: it spawns processes, binds
  ports and takes seconds per case.
- One router process per file, shared by its cases; files do not run in
  parallel, so two suites never contend for a port or a ledger.
- Everything is resolved from source (`@confidential-router/source`), so a suite
  is never held to a stale `dist/` of the tools it drives.
- The `e2e` target builds `router-api`, the gatekeeper's own binaries and the
  stand binary first, so a Go toolchain is needed to run it. CI runs it
  unconditionally rather than through `nx affected`: the seams it covers live in
  libraries, and a change that breaks one rarely touches every project involved
  (the ADR-007 §7a precedent).

## When one fails

The stack attaches the router's own log to a startup failure. For a failure
further in, `stack.router.log()` has everything the process wrote — the
migration lines, the magic link, the request log — and
`stack.backend.requests` has every request the router forwarded upstream.
