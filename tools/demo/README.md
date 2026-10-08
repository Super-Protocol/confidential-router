# demo

The end-to-end story, and the harness the e2e suites are built on.

```bash
pnpm demo                       # or: pnpm nx run gatekeeper:e2e
pnpm exec tsx tools/demo/src/main.ts --verbose
```

```
OpenAI SDK ─▶ gatekeeper ─▶ mock-evidence-host (TLS) ─▶ router-api ─▶ mock-litellm
                  │                  │                       │
                  └── verifies ──────┘                       │  /.well-known/swarm-evidence
                                                             ▼
                              gatekeeper-sidecar ═ TLS, pinned leaf ═▶ mock-evidence-host
                              (the router's egress)                    + mock-litellm
                                                                       "another cloud"
```

The same verification, twice, in opposite directions: the user's gatekeeper
verifies the router, and the router verifies a model endpoint in someone else's
deployment (ADR-008).

## What the story asserts

Twelve steps, each checked; the script exits non-zero at the first one that does
not hold, so the demo someone watches and the check CI runs are the same thing.

1. the stack comes up — the built `router-api`, the model backend, the publisher
2. a user signs in, buys credit and mints a key, **through the console's own
   API** — there is no path here that reaches into the database
3. a gatekeeper is configured from nothing, with the commands `init` prints
4. it verifies what the endpoint publishes and pins that digest
5. an OpenAI SDK call reaches a model through it
6. the router metered the generation and charged the workspace
7. the deployment is rotated — same cloud, same signature, different digest
8. **the next call is refused**: 503, `stage: policy`, with the reason
9. the new digest is pinned, `SIGHUP`, and traffic resumes
10. an admin registers a model endpoint in **another cloud** and lists that
    cloud's measurement; the router attests it itself and publishes its model
11. a call reaches that model — the user verified the router, the router
    verified the upstream, and the upstream saw its own API key
12. **that cloud redeploys on an image nobody listed**: the model leaves
    `/v1/models` and the next call is refused, fail-closed again

Steps 8 and 12 are why this exists, and they are one property seen from both
sides: a proxy that *stops* when the thing it verified changes underneath it.
Everything else is a happy path a dozen unit tests already cover, and nothing
short of a live rotation demonstrates either.

## The pieces

| Module | What it owns |
| --- | --- |
| `router-process.ts` | `apps/router-api/dist/main.js` as a child process: config file, migrations, `/health`, and its log |
| `console-client.ts` | a headless console session — magic-link sign-in, top-up, key minting, GraphQL |
| `stack.ts` | `startRouterStack()`: the two stand-ins, the router behind them, a signed-in session with credits and a key |
| `gatekeeper.ts` | the real `apps/gatekeeper/bin/gatekeeper`, one command at a time, plus `run --headless` |
| `external-stand.ts` | `startExternalStand()`: an upstream in another cloud, the real egress sidecar over it, and the admin API that registers one |
| `story.ts` | the twelve steps above |
| `serve.ts` | the stack as a long-lived server, for the browser-driven suite |

`startRouterStack()` and `startExternalStand()` are also what
`apps/router-api-e2e` runs against, which is the reason this is a library and not
one script.

## The one thing that is not real

`external-stand.ts` runs the shipped `gatekeeper-sidecar` over
`apps/gatekeeper/cmd/gatekeeper-teststand` — the gatekeeper with its
attested-root *hardware* leg read from a JSON file. A SEV-SNP report is signed by
AMD and its `reportData` commits to the issuing CA's public key, so no mock can
mint one and no stand can issue leaves from the one real fixture the repository
holds. The build tag keeps that file out of every release build; everything else
in the chain — the rendered config, the evidence fetch, JWS and chain
verification, the channel binding, the Rego policy set, the trust store, the
forced re-attestation, the fail-closed drop of in-flight connections — is the
production code path, and the substitution says so in the verdict's own logs.

## Why the sign-in goes through the product

Nothing here seeds the database. A demo that inserted its own workspace and key
rows would prove that the *database* works; going through
`/auth/sign-in/magic-link`, `createCheckout` and `createApiKey` proves the
product does, and it fails the moment either surface changes shape.

The magic link is read out of the router's log, because the development mailer
writes it there (`auth.magicLink.mailer: console`) and there is no mail provider
in a test. It is the same line `docker compose logs api` shows a person.

## `serve.ts`

```bash
pnpm exec tsx tools/demo/src/serve.ts
```

Same stack, left running, with two differences: the router binds a **fixed**
port (the console inlines its API origin at build time and cannot be pointed
elsewhere afterwards), and the deny-path controls are exposed under `/__mock`.
Whatever a browser cannot discover over HTTP — the session cookie, the workspace
id, the plaintext key, the trusted root — is written to
`test-output/demo-stack.json`. `docs/quickstart.md` drives it by hand.

## Timing

The whole story runs in a few seconds on a laptop. The acceptance criterion for
SUP-84 is under ten minutes in CI, and the script prints its own wall clock so
that stays observable rather than assumed.
