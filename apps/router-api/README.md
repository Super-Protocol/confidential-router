# router-api

The Confidential Router backend: an OpenAI-compatible `/v1` gateway plus the
GraphQL API behind the console. Configuration, persistence, authentication and
health are the foundation; the metering gateway on top of them is what a client
actually talks to.

User-facing reference: [`docs/router.md`](../../docs/router.md) — models,
LiteLLM, endpoints, evidence, auth and Stripe. This file is about building and
hacking on the service.

## Quick start

```bash
pnpm nx serve router-api
```

That boots on SQLite with no configuration file and no environment variables:
the schema defaults are a working development setup, migrations run at startup,
and the database lands in `data/router-api.sqlite`. Then:

- `http://localhost:3000/v1/*` — the OpenAI-compatible gateway
- `http://localhost:3000/health` — liveness plus a real database round-trip
- `http://localhost:3000/graphql` — Apollo, `{ me { id email } }`; the catalogue (`{ models { id } }`)
  answers without a session
- `http://localhost:3000/docs` — Swagger UI for the REST surface
- `http://localhost:3000/auth/*` — Better Auth

Sign in without configuring a mail provider: `POST /auth/sign-in/magic-link` with
`{"email":"you@example.com","callbackURL":"/"}`, then open the link the log
prints.

## The `/v1` gateway

The OpenAI API, with the router's own identity and meter attached. The contract
is [`docs/contracts/router-api.md`](../../docs/contracts/router-api.md); the
short version:

```bash
curl http://localhost:3000/v1/chat/completions \
  -H 'Authorization: Bearer sk-tee-v1-…' \
  -H 'Content-Type: application/json' \
  -d '{"model":"meta/llama-3.3-70b-instruct:tdx","messages":[{"role":"user","content":"hi"}],"stream":true}'
```

| Route | Notes |
| --- | --- |
| `POST /v1/chat/completions` | non-stream and SSE, forwarded chunk by chunk |
| `POST /v1/completions` | legacy text completions |
| `POST /v1/embeddings` | models whose `capabilities` include `embeddings` |
| `GET /v1/models`, `GET /v1/models/{id}` | the key's slice of the catalogue |
| `GET /v1/generation?id=gen-…` | what one request was metered at |

What the gateway does to a request, in order: authenticate the key, resolve
`model` against the router config, check the key's scope, the workspace's credit
and the key's spend limit, charge the rate-limit budgets, mint a `gen-<ulid>`,
forward to LiteLLM with `model` rewritten, and write one `Generation` row when
it finishes — including when it fails. The response carries
`X-Confidential-Router-Endpoint` (the hostname that served it) and
`X-Confidential-Router-Generation-Id`; `usage` gains `cost_micros`, `endpoint`
and `evidence_digest`.

`evidence_digest` is the digest the platform had published for that endpoint at
the time — **evidence coverage, never a verdict**. The router does not know
whether it was verified; that happens in the user's gatekeeper (ADR-002).

Prompts and completions are forwarded and never stored. `generations` has no
column that could hold them, and `invariants.spec.ts` fails the build if one
appears.

Two seams are deliberate, both single providers:

- `RATE_LIMITER` (`api/v1/v1.module.ts`) is an in-process token bucket, correct
  for one replica. A Redis adapter replaces it without touching a caller.
- `CREDITS_GATEWAY` (`metering/metering.module.ts`) reads
  `workspaces.balanceMicros` and does not write the ledger — the append-only
  `credit_transactions` writer is SUP-75's, and decrementing the cached balance
  without it would break `data-model.md` invariant 3.

## Configuration

Two sources, later wins:

1. `conf/router.yaml` — looked up under the working directory first, then beside
   the running bundle. Override the path with `CR_API_CONFIG_FILE`.
2. `CR_API_*` environment variables. `__` separates object levels and each level
   is read as snake_case: `CR_API_SERVER__PORT=4000` sets `server.port`,
   `CR_API_AUTH__GITHUB__CLIENT_ID` sets `auth.github.clientId`.

   Two names under that prefix are meta-variables, not configuration, and are
   skipped by the loader: `CR_API_CONFIG_FILE` (where to look) and
   `CR_API_VERSION` (the build identifier `/health` reports).

Every section is strict. An unknown key — `CR_API_SERVER__PROT=4000`, a stray
setting in the YAML — fails the boot rather than being silently dropped, which
matches `additionalProperties: false` in the JSON Schema.

Both are validated once, at boot, against the Zod schema in
`src/app/config.schema.ts` — the runtime mirror of
[`schemas/router-config.schema.json`](../../schemas/router-config.schema.json).
A test parses the committed example against both so they cannot drift.

Values in the YAML may reference the environment as `${VAR}` or `${VAR:-default}`;
an unset placeholder with no default fails the boot rather than surfacing later
as a confusing validation error.

Two settings behave differently in production:

| Setting | Development | Production (`NODE_ENV=production`) |
| --- | --- | --- |
| `auth.secret` | minted per process, with a warning | required; the boot fails without it |
| `auth.magicLink.mailer: console` | prints the link to the log | rejected — configure `resend` |

## Database

PostgreSQL in production, SQLite everywhere else. The schema is portable by
construction: timestamps are epoch milliseconds in a `bigint`, money and counters
are `bigint` read back as `number`, structured payloads are JSON in `text`. See
`src/app/db/columns.ts` and [`docs/contracts/data-model.md`](../../docs/contracts/data-model.md).

`synchronize` is off on both drivers. Migrations own the schema, so what a
developer runs against is what CI and production get:

```bash
# apply everything (Better Auth's four tables, then this service's ten)
pnpm nx run router-api:migrate
```

In a container that command is the image's `migrate` argument — the same entry
point, the same bundle:

```bash
docker run --rm \
  -e CR_API_DATABASE__TYPE=postgres \
  -e CR_API_DATABASE__URL=postgres://… \
  -e CR_API_AUTH__SECRET=… \
  ghcr.io/super-protocol/confidential-router/router-api:1.0.0 migrate
```

Run it once per deployment, from a job or an init container, before the replicas
roll. It is idempotent: a re-run against an up-to-date database prints
`No pending migrations.` and exits 0. With no argument the image serves;
[`docker/README.md`](../../docker/README.md) has the rest.

`database.migrationsRun` defaults to `true` on SQLite (so `nx serve` works on an
empty directory) and `false` on PostgreSQL, where a deployment runs the command
above once from a job rather than racing every replica.

Migrations are **written by hand** against TypeORM's dialect-neutral `Table` API,
not generated. `migration:generate` emits SQL for whichever database it was
pointed at, which is exactly the portability this schema is built to avoid.

`src/app/db/migrations.spec.ts` asserts that the migrated schema is *exactly* the
schema the entities describe, on both databases — the PostgreSQL half runs when
`CR_TEST_POSTGRES_URL` is set, which CI does.

## Model catalogue and evidence

`endpoints[]` and `models[]` in the config are the source of truth for both
(ADR-002). At boot they are projected into the `endpoints` and `models` tables so
a metered generation can take a foreign key on the model it used; an entry the
config no longer lists is kept with `enabled = false` rather than deleted, so
past generations still resolve. Nothing creates or edits either through the API.

A development catalogue — the design prototype's eight open-weight models across
three confidential endpoints — is committed as `conf/router.dev-seed.yaml`:

```bash
CR_API_CONFIG_FILE=conf/router.dev-seed.yaml pnpm nx serve router-api
```

Its two backend addresses are `${VAR:-default}` placeholders, so the same file
serves a laptop (the defaults, `127.0.0.1`) and the compose demo stack, which
sets `CR_DEMO_LITELLM_URL` and `CR_DEMO_EVIDENCE_BASE` to service names on the
compose network. Neither is a `CR_API_*` variable: they are substituted into the
file, not read as configuration.

Evidence is *retrieved*, never adjudicated. `EvidencePollerService` fetches
`https://<hostname>/.well-known/swarm-evidence` for every endpoint every
`evidence.pollInterval` (0 disables it), validates the bundle's shape, decodes
the JWS payload **without verifying the signature**, and files an
`EvidenceSnapshot`. Snapshots are idempotent on
`(endpointId, evidenceDigest, certFingerprint, issuedAt)`, which is what makes
the poller replica-safe without leader election.

The console reads it back through `endpoints`, `evidenceSnapshots`,
`evidenceDigestHistory`, `evidenceCoverage` and the `refreshEvidence` mutation
("Fetch fresh quote"); `GET /v1/evidence/<name-or-hostname>` hands the raw bundle
to tooling without a key, because the platform serves the same document
publicly.

What this service will never have is a verdict. Whether a bundle's signature is
good, whether its chain terminates at a root you trust, whether the digest is the
one you pinned — those are questions for the gatekeeper on the user's own
machine. `test/evidence.e2e.spec.ts` introspects the GraphQL schema and fails the
build if a field named `verified`, `trusted` or `valid` ever appears.

## Authentication

Better Auth (ADR-004), mounted at `/auth/*`, sharing the one database. OAuth
(GitHub, Google) and email magic link; no passwords, no wallet, no second store.
Better Auth owns `user`, `session`, `account` and `verification` and migrates them
itself; this service's TypeORM migration owns the other ten tables and takes no
database-level foreign key on `user`, so the two stay independent.

In application code the surface is deliberately small:

```ts
@Query(() => ViewerModel)
@UseGuards(SessionGuard)
async me(@CurrentUser() user: SessionUser) { … }
```

`SessionGuard` works for REST and GraphQL alike and accepts a session cookie and
nothing else. `/v1/*` authenticates with `Authorization: Bearer sk-tee-v1-…`
through `ApiKeyGuard`, and the two are never interchangeable: a session cannot
call the gateway and a key cannot mint another key.

API keys are `sk-tee-v1-` plus 32 random bytes, base64url. Only `sha256(key)` and
the first twelve characters reach the database; the plaintext is returned once,
by `createApiKey`, and cannot be recovered.

Every workspace-scoped read goes through `WorkspaceScopeService`, which is the
single place tenancy is enforced.

## Billing

Prepaid credits in integer micro-USD (ADR-005). `credit_transactions` is append-only and
`workspaces.balanceMicros` is its cached sum; `LedgerService` is the only writer of either and keeps them
equal in one transaction per entry. A repeated event cannot charge twice: every entry carries an
`idempotencyKey` under a unique index, so a redelivered Stripe webhook or a retried debit returns the row
that already exists.

`MeteringModule` binds this under `CREDITS_GATEWAY`, so every generation the `/v1` gateway serves writes
its `usage` row through the ledger, keyed on the generation id — a retried metering write cannot charge
twice.

A generation may overdraw: its cost is not known until it has been generated, and the *next* request is
what gets refused (`402 insufficient_credits`). A refund may overdraw too — the provider has already moved
the money, and a ledger that refused to record it would permanently disagree with the provider. An
operator adjustment, whose amount is known and who has a human behind it, cannot take the balance below
zero.

The payment provider sits behind `PaymentProvider`:

| `billing.stripe` | Provider | Top-up flow |
| --- | --- | --- |
| configured | `StripePaymentProvider` | Checkout Session → `POST /billing/stripe/webhook` (signature over the raw body) → ledger |
| absent, outside production | `ManualPaymentProvider` | a signed link → `GET /billing/manual/complete` → ledger |
| absent, in production | — | the boot fails: a link that mints credit must not run against real customers |

The manual provider is what lets `nx serve` and the e2e suite exercise a complete top-up with no Stripe
credentials and no network. Automatic top-up charges the card saved by the first checkout when the
balance falls under `autoTopUpThresholdMicros`, at most once per `billing.autoTopUpCooldown`; the claim is
written before the charge, so concurrent generations produce one charge and a declining card backs off
instead of retrying per request.

## The console GraphQL API

Code-first Apollo at `/graphql`, one schema for all nine console screens
([`docs/contracts/console-graphql.md`](../../docs/contracts/console-graphql.md)). Every operation is
behind `SessionGuard` and scoped through `WorkspaceScopeService` — except `models` and `model`, which are
public, because a router that meters LLM traffic has to be able to say what it routes to, and at what
price, before anyone signs up.

The emitted SDL is committed to [`schema.graphql`](schema.graphql) and is what `apps/router-ui` generates
its Apollo client from:

```bash
pnpm nx run @confidential-router/router-api:schema   # rewrite schema.graphql after changing a resolver
```

Two checks keep the file honest, and both run in CI: `src/app/api/graphql/schema.spec.ts` compares it with
the schema built from the resolver metadata, and `test/schema.e2e.spec.ts` compares it with the schema the
booted application serves. `CONSOLE_RESOLVERS` is one array — the module's provider list and the SDL
builder read the same one — so a resolver cannot reach the running API without reaching the file.

A GraphQL response is `200` whatever happened, so `extensions.code` is the only thing a client can branch
on. `src/app/api/graphql/errors.ts` is the one place a Nest exception's HTTP status becomes a code:
`UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `BAD_USER_INPUT`, `PAYMENT_REQUIRED`, `CONFLICT`,
`TOO_MANY_REQUESTS`, `INTERNAL_SERVER_ERROR`. With `graphql.introspection` off — the production default —
an unmapped failure loses its message and its stack, because a driver message is exactly the kind of thing
that leaks a table name.

### Gatekeeper downloads

`gatekeeperRelease` is the Gatekeeper screen's only query: the version, the release notes, the checksum
manifest and one download per platform, read from GitHub Releases (`gatekeeper.repo`) and cached for
`gatekeeper.cacheTtl`. It is refreshed lazily when the console asks, never on a timer, and concurrent asks
share one request. A refresh that fails keeps the last known links and marks them `stale` rather than
emptying the screen.

It describes an artefact and nothing else. There is no gatekeeper registration, instance list or status
anywhere in this API: verification happens on the user's machine and this router never learns that it
happened (ADR-002).

## Downloads

Two things the console needs are files rather than GraphQL responses:

- `GET /activity/generations.csv?workspaceId=…` — the generation log, session-authenticated, same filters
  as the `generations` query.
- `GET /exports/evidence.zip?token=…` — what the endpoints published for a period, as a zip with a
  manifest. The token is minted by the `exportEvidence` mutation, signed with `auth.secret` and valid for
  15 minutes: the export exists to be handed to an auditor, who has no console session. Membership is
  re-checked when the link is followed.

The archive contains no verdict. The router publishes evidence and never verifies it (ADR-002); whoever
receives the zip verifies it with the gatekeeper.

## Layout

```
src/
  main.ts                 process entry; bootstrap.ts holds the middleware stack
  app/
    config.ts             two-source loader + Zod schema
    db/                   entities, portable column presets, DataSource factory
    auth/                 Better Auth, guards, workspace scoping and provisioning
    api-keys/             minting, hashing and authentication of /v1 credentials
    catalog/              config → endpoints/models projection, served from memory
    evidence/             bundle retrieval, snapshots, poller, coverage, /v1/evidence
    metering/             pricing, token estimation, evidence coverage, the meter
    activity/             SQL aggregates, the generation log and its CSV
    billing/              credits ledger, payment providers, automatic top-up
    preferences/          console settings and the evidence export
    api/health            /health
    gatekeeper/           GitHub release metadata for the console's download screen
    api/graphql           Apollo code-first schema, its error codes and the committed SDL
    api/v1                the OpenAI-compatible gateway
  migrations/             TypeORM migrations, imported explicitly for bundling
  cli/run-migrations.ts   the migration command a deployment runs
test/                     supertest e2e against the real module graph
tools/runtime-deps.cjs    the one list of packages webpack leaves external and
                          the container image installs — read by webpack.config.js
                          and by router-api.dockerfile
```

## Tests

```bash
pnpm nx test router-api                                   # unit + e2e, on SQLite
CR_TEST_POSTGRES_URL=postgres://… pnpm nx test router-api  # adds the PostgreSQL suite
```

The e2e suites boot the real `AppModule` with the real middleware stack and swap
only the mailer, so a CORS or Helmet difference between tests and production
cannot hide. The gateway suites add a mock LiteLLM (`test/mock-litellm.ts`) whose
behaviour — streaming, a crash, a 429, an over-long prompt, a dropped connection
— is chosen by the `litellmModel` the router forwards, and
`test/openai-sdk.e2e.spec.ts` drives a running router with the real `openai`
client to check the "swap one base URL" promise end to end.

All of that runs *in process*, which is the right shape for testing an
application and cannot show that the built artefact starts, reads its
configuration file, applies its migrations and answers on a socket.
[`apps/router-api-e2e`](../router-api-e2e) covers exactly that, against
`dist/main.js` over real HTTP:

```bash
pnpm nx run @confidential-router/router-api-e2e:e2e
```
