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
- [First sign-in on a fresh deployment](#first-sign-in-on-a-fresh-deployment)
- [Email and password, where there is no mail](#email-and-password-where-there-is-no-mail)
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

OAuth and magic link, and — where a deployment has neither — a bootstrap token
and email with a password. Sessions live in the database. Better Auth owns four
tables and its own migration (ADR-004).

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
the log can use. `mailer: none` switches magic-link sign-in off altogether —
`/auth/sign-in/magic-link` is not mounted — which is what lets a deployment with
no mail provider boot in production at all.

Every new user gets a personal workspace on first sign-in. `/v1` takes no
cookies and no query parameters — a `Bearer sk-tee-v1-…` key, and nothing else.
Only `sha256(key)` is stored; the plaintext exists for the length of one GraphQL
response.

The console asks `signInOptions` — the one public query it makes before there is
a session — for which of these paths this deployment actually offers, and renders
only those, `password` and `passwordMinLength` among them. A "Continue with
GitHub" button on a deployment with no GitHub app can only end in an error.

## First sign-in on a fresh deployment

A deployment can be brought up with no mailer and no OAuth app — a marketplace
install is exactly that — and then none of the paths above can produce the first
account. `auth.bootstrapToken` is the way in:

```yaml
auth:
  bootstrapToken: ${CR_API_BOOTSTRAP_TOKEN}   # at least 16 characters; blank counts as unset
  bootstrapEmail: admin@example.com           # default: admin@confidential-router.local
  magicLink:
    mailer: none                              # no mail on this deployment
```

While that token is set **and** the `user` table is still empty, the console's
sign-in screen offers "Have a bootstrap token?", and posting the token creates
the first account, its personal workspace and a session.

By hand, against **the API's own origin** — `auth.baseUrl`, where `/auth/*` is
mounted. That is usually not the console's hostname: a deployment that puts the
console and the API on separate names (as the marketplace listing does, with
`consoleHostname` and `apiHostname`) has to use the latter here.

```bash
curl -i -X POST https://api.example.com/auth/bootstrap \
  -H 'content-type: application/json' \
  -H 'origin: https://console.example.com' \
  -d '{"token":"…"}'
# 200, Set-Cookie: cr_session=…
```

The `origin` header is only needed when you send one at all — a browser always
does, and it must be listed in `server.validClientOrigins` or the request is
refused with 403.

What the endpoint promises:

- **Once.** The first account closes it. `user.email` is unique, so two
  simultaneous requests cannot both win — the loser gets the same 404 as anyone
  arriving afterwards.
- **404, not 403.** With no token configured the endpoint is not mounted at all;
  once the deployment has an owner it answers 404. Neither state confirms to an
  anonymous caller that a bootstrap token exists. A *wrong* token while
  bootstrap is genuinely open answers 401, because at that point availability is
  already public (`signInOptions.bootstrap`) and a typo deserves a retry.
- **Constant-time, and never logged.** The token is compared through SHA-256
  digests, so neither its value nor its length leaks through timing, and it is
  not written to the log, echoed in a response or exposed by any query.
- **Rate-limited** to five attempts a minute per source, in production.

Afterwards the account is an ordinary one: it owns its workspace and it is the
account a magic link to `bootstrapEmail` signs into, so a deployment that later
configures a mailer or an OAuth app is not left with a stranded admin. It is
also the *only* account the token can make — everyone after the first gets in
through OAuth, a magic link, or
[email and password](#email-and-password-where-there-is-no-mail). There is
no separate "admin" role — this product's only role is workspace ownership.
Clearing `bootstrapToken` is optional; the endpoint is already closed.

## Email and password, where there is no mail

A bootstrap token creates exactly one account. On a deployment that also has no
mailer and no OAuth app, everyone after that first person has no way in at all —
which is what `auth.password.enabled` is for. It is the only sign-in path that
needs nothing outside the cluster.

```yaml
auth:
  password:
    enabled: true      # default false; the marketplace listing turns it on
    minLength: 12      # the router's rule, reported to the console
  magicLink:
    mailer: none       # no mail on this deployment, and none needed
```

With it on, `POST /auth/sign-up/email` creates the account, its personal
workspace and a session in one request, and `POST /auth/sign-in/email` signs it
in afterwards. The console renders both forms — `/login` and `/signup` — from
`signInOptions.password`.

```bash
curl -i -X POST https://api.example.com/auth/sign-up/email \
  -H 'content-type: application/json' \
  -H 'origin: https://console.example.com' \
  -d '{"email":"someone@example.com","password":"…","name":"Some One"}'
# 200, Set-Cookie: cr_session=…
```

What this path deliberately does **not** have:

- **No email verification.** The address is never proven, because proving it is
  a mail round trip and the whole premise here is that there is no mail. Treat
  addresses on such a deployment as self-asserted labels, not as identities.
- **No password reset.** `/auth/request-password-reset` and
  `/auth/reset-password` are 404 on every deployment, enabled or not, for the
  same reason. A forgotten password on a mailer-less deployment is a new
  account, and the sign-up form says so.
- **No open door where it is off.** `enabled: false` is the default, and then
  `/auth/sign-up/email`, `/auth/sign-in/email`, `/auth/change-password` and
  `/auth/verify-password` are all 404 — not "provider disabled", because an
  unavailable path here is not a thing that exists.

Two consequences worth deciding about before turning it on:

- **Anyone who can reach the console can create an account.** There are no
  invitations in v1, so a deployment on a public hostname with passwords on is
  open for sign-up. It is no risk to anyone else's data — a new account gets its
  own empty workspace, no credit and no access to anybody's keys — but it is
  rows in your database. Put something in front of the hostname if that matters.
- **The bootstrap window closes on the first account, whoever created it.**
  `POST /auth/bootstrap` is gated on the deployment having no user at all. Claim
  the deployment with the token before publishing the hostname, not after.

Passwords are hashed with Better Auth's scrypt; `auth.password.minLength` is the
only rule the router enforces, and the console reads it from `signInOptions`
rather than restating it, so raising it does not leave the form advertising a
floor the API refuses.

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
