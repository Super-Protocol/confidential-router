# Router

`apps/router-api` is the server side: an OpenAI-compatible gateway in front of
models running in a confidential cluster, a token meter, a credits ledger, and
the GraphQL API the console reads.

The one rule that shapes everything here: **the router does not know when,
whether, or by whom it is attested** (ADR-002). It publishes nothing about
verification, stores no verdict, and has no concept of a gatekeeper. It routes,
meters and bills; what it *can* say about evidence is "the platform had this
bundle published for this endpoint when we served your request", which is a fact
about publication, never a verdict.

- [Configuration](#configuration)
- [Models, endpoints and LiteLLM](#models-endpoints-and-litellm)
- [Evidence](#evidence)
- [Auth](#auth)
- [Billing and Stripe](#billing-and-stripe)
- [The OpenAI-compatible surface](#the-openai-compatible-surface)
- [Running it](#running-it)

## Configuration

One YAML file, plus `CR_API_*` environment variables for anything a deployment
needs to override. Normative schema: `schemas/router-config.schema.json`; a
fully populated file: `schemas/examples/router-config.example.yaml`.

```
schema defaults → the config file → CR_API_* environment
```

`CR_API_` variables address the document with `__` as the separator:
`CR_API_DATABASE__URL`, `CR_API_SERVER__PUBLIC_BASE_URL`,
`CR_API_BACKENDS__LITELLM__BASE_URL`. The file itself expands `${VAR}` and
`${VAR:-default}`, which is how the committed dev files stay usable both on a
laptop and inside compose.

`conf/router.yaml` is the development file and is also exactly the schema
defaults — deleting it changes nothing. `conf/router.dev-seed.yaml` adds the
eight models and three endpoints of the design prototype, so the console has
something real to render without a cluster.

```yaml
version: 1

server:
  port: 3000
  host: 0.0.0.0
  publicBaseUrl: https://console.tee.swarm.cloud   # what the API builds links against
  validClientOrigins:                              # CORS + Better Auth trusted origins
    - https://console.tee.swarm.cloud

database:
  type: postgres                # `sqlite` for development
  url: ${CR_API_DATABASE_URL}
  migrationsRun: false          # see "Running it"
```

## Models, endpoints and LiteLLM

Three things, in one file, related by name.

**`backends.litellm`** is where every `/v1` request is forwarded. LiteLLM runs
inside the same confidential cluster, so this is plain HTTP over the cluster
network — the confidentiality boundary is the cluster, not this hop.

```yaml
backends:
  litellm:
    baseUrl: http://litellm.cr-prod.svc.cluster.local:4000
    apiKey: ${CR_API_LITELLM_KEY}     # optional; never forwarded to a client
    connectTimeout: 5s
    readTimeout: 120s
```

**`endpoints[]`** are the router's own hostnames — the things a gatekeeper
attests. The platform publishes `/.well-known/swarm-evidence` for each of them;
the router only retrieves what is there.

```yaml
endpoints:
  - name: llama-33-70b                         # referenced by models[].endpoint
    hostname: llama-33-70b.tee.swarm.cloud     # what the bundle must name
    tee: Intel TDX + H100 CC                   # an operator label, never a claim
  - name: deepseek-v3
    hostname: deepseek-v3.tee.swarm.cloud
    tee: Intel TDX + H100 CC
    # Operator-only override for clusters where the public hostname does not
    # resolve from inside. The bundle it serves must still name `hostname`,
    # which is what stops this from becoming a way to file one endpoint's
    # evidence under another.
    evidenceUrl: http://evidence-mirror.cr-prod.svc.cluster.local/deepseek-v3
```

**`models[]`** is the catalogue `/v1/models` serves and the console renders. It
maps a public model id to a LiteLLM model and to the endpoint that serves it.

```yaml
models:
  - id: meta/llama-3.3-70b-instruct:tdx      # what a client asks for
    name: Llama 3.3 70B Instruct
    litellmModel: vllm/llama-3.3-70b-instruct # what LiteLLM is asked for
    endpoint: llama-33-70b
    contextLength: 131072
    capabilities: [chat, completions]
    # Micro-USD per 1M tokens: $0.28 / 1M prompt tokens is 280000.
    pricing: { promptPer1mMicros: 280000, completionPer1mMicros: 420000 }
```

A model id the catalogue does not list is a `404 model_not_found`, not a
forwarded request: the router never guesses what a backend might answer to.

Rate limits apply per key *and* per workspace, so minting more keys does not
multiply a tenant's budget:

```yaml
rateLimits:
  requestsPerMinute: 600
  tokensPerMinute: 2000000
```

## Evidence

```yaml
evidence:
  pollInterval: 5m        # how often each endpoint is retrieved
  freshnessWindow: 24h    # past this, a publication reads as stale
```

The poller fetches each endpoint's bundle, stores the publication and moves on.
It does not verify signatures, does not check the chain against anything, and
never produces a verdict — a gatekeeper does that, on the user's side, with the
user's own trusted roots.

What the console gets out of it:

- **the latest publication** per endpoint, with its `evidenceDigest` (the value
  a gatekeeper user pins), the certificate chain summary, the container images
  from the snapshot and the raw bundle for offline verification;
- **the digest history** — every distinct digest an endpoint has published, and
  when. That is "when would a pinned value have had to change";
- **evidence coverage** — of the generations served in a window, how many were
  served while a fresh bundle was published for the endpoint that served them.
  A fact about publication. Not a verification rate, and the console says so.

If the platform publishes nothing, the endpoints read "Not published" and the
screens are empty. That is the honest state, and it is what a laptop shows.

## Auth

OAuth and magic link only; no passwords anywhere. Sessions live in the database.
Better Auth owns four tables and its own migration (ADR-004).

```yaml
auth:
  baseUrl: https://console.tee.swarm.cloud
  secret: ${CR_API_AUTH_SECRET}          # required in production
  github: { clientId: ${CR_API_GITHUB_CLIENT_ID}, clientSecret: ${CR_API_GITHUB_CLIENT_SECRET} }
  google: { clientId: ${CR_API_GOOGLE_CLIENT_ID}, clientSecret: ${CR_API_GOOGLE_CLIENT_SECRET} }
  magicLink:
    mailer: resend                       # `console` outside production
    from: no-reply@tee.swarm.cloud
    resendApiKey: ${CR_API_RESEND_KEY}
```

`mailer: console` writes the sign-in URL to the log instead of sending it, which
is what makes a headless demo possible. The service refuses to boot with it in
production, because a sign-in link in a log file is a sign-in link anybody with
the log can use.

Every new user gets a personal workspace on first sign-in. `/v1` takes no
cookies and no query parameters — a `Bearer sk-tee-v1-…` key, and nothing else.
Only `sha256(key)` is stored; the plaintext exists for the length of one GraphQL
response.

## Billing and Stripe

Credits are an append-only ledger; `workspaces.balanceMicros` is its running
sum, written only in the same transaction as the row that moved it. A correction
is a new row with a negative amount, never an edit. Every write carries an
idempotency key, so a redelivered webhook or a retried debit cannot charge
twice.

```yaml
billing:
  minTopUpMicros: 5000000              # $5
  allowOverdraftMicros: 0              # how far a generation may push a balance negative
  checkoutReturnUrl: https://console.example.com/credits
  autoTopUpCooldown: 1h                # floor between two automatic top-ups of one workspace
  stripe:
    secretKey: ${CR_API_STRIPE_SECRET_KEY}
    webhookSecret: ${CR_API_STRIPE_WEBHOOK_SECRET}
    currency: usd
```

The payment provider sits behind an interface (ADR-005). Stripe is the only
implementation, and there are no crypto payments. Outside production the module
binds a **manual provider** instead: `createCheckout` hands back a link,
following the link *is* the payment, and the redirect credits the ledger — the
same redirect-then-confirm sequence Stripe drives, without a card or a network.
`BillingModule` refuses to bind it in production.

A top-up flow, end to end: `createCheckout` → the provider's URL → Stripe's
webhook (or the manual confirm endpoint) → one `purchase` ledger row → the
balance moves. Auto top-up charges a saved card when the balance falls below a
threshold, no more often than `autoTopUpCooldown`.

## The OpenAI-compatible surface

```
POST /v1/chat/completions      streaming and not
POST /v1/completions
GET  /v1/models
GET  /v1/generation?id=…       what one request cost, after the fact
```

Full contract: `docs/contracts/router-api.md`, and Swagger at `/docs` when
`swagger.enabled`.

The meter is exact rather than estimated: the router always asks the backend for
`stream_options.include_usage`, and strips the extra chunk again if the client
did not ask for it. **Prompt and completion content is never stored** — the
generation row holds token counts, cost, latency and status, and nothing you
sent.

## Running it

```bash
pnpm nx run @confidential-router/router-api:build       # → apps/router-api/dist
node apps/router-api/dist/main.js                        # serve
node apps/router-api/dist/cli/run-migrations.js          # apply the schema
```

SQLite applies migrations at boot (`database.migrationsRun: true`, the
development default). PostgreSQL deployments run the migration CLI **once**,
from a job or an init container, and leave `migrationsRun` off — otherwise
every replica races the others at startup.

Container image: `router-api.dockerfile`, published to ghcr by the release
workflow. `docker/docker-compose.yml` runs the API, the console and PostgreSQL
together; `--profile demo` adds the two stand-ins that make it answer real
generations. `docker/README.md` first — the credentials in it are committed.

## See also

- [`docs/quickstart.md`](quickstart.md) — the whole product in ten minutes
- [`docs/gatekeeper.md`](gatekeeper.md) — the other side of the connection
- [`docs/contracts/router-api.md`](contracts/router-api.md) — the `/v1` and GraphQL contracts
- [`docs/contracts/data-model.md`](contracts/data-model.md) — the tables
- [`docs/adr/`](adr/) — attestation topology, auth, billing
- [`apps/router-api/README.md`](../apps/router-api/README.md) — building and hacking on it
