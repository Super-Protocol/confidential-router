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

## Invitation codes

A mailed campaign hands out credit without the recipient ever typing a code
(SUP-140). The invitation is a link — `https://router.superprotocol.com/?invite=ABCD-EFGH-JKMN&utm_…` —
the landing page carries the code to sign-up, and creating the account is what
spends it.

```yaml
invites:
  landingBaseUrl: https://router.superprotocol.com   # only the generation CLI reads this
  lookupsPerMinute: 30                               # per source address on the public lookup
auth:
  adminEmails: [ops@example.com]                     # who may read the campaign aggregates
```

Nothing switches the feature on: with no codes generated it is inert.

**Generating a campaign.** There is no API for minting codes, deliberately — an
endpoint that creates credit is a thing to be attacked, and a CLI behind an
operator's database access is not.

```bash
node apps/router-api/dist/cli/invites.js generate \
  --count 5000 --grant 100 --campaign launch-2026-10-devs \
  --expires 2026-12-31 --out codes.csv
node apps/router-api/dist/cli/invites.js stats --campaign launch-2026-10-devs
```

`--grant` is USD, not micros. `--expires 2026-12-31` means "valid through the
31st". `--out` refuses to overwrite an existing file unless `--force` is given:
the CSV is the only copy of the codes outside the database. The two columns are
`code,url`, which is what the mailing tool consumes.

**Redeeming.** The code is spent inside account creation — Better Auth's
`user.create.after` hook — and nowhere else. There is no redeem endpoint and no
redeem mutation, so there is nothing a client can replay, call for someone else's
account, or call twice. In one transaction: a seat is claimed on the code, a
`grant` row is appended to the ledger, and the redemption is recorded.

Because redemption lives in the creating request, the code has to be recovered
from whichever request created the user, and the sign-in paths carry different
things. Four sources are read, in order:

| Source | The path it covers |
| --- | --- |
| `inviteCode` in the request body | `POST /auth/sign-up/email` — the console's own request |
| `?invite=` on the request | the same, with the code appended to the URL |
| `invite` inside `callbackURL` | magic link: `callbackURL` is the only thing of ours the verify request keeps |
| the `cr_invite` cookie | OAuth: the provider builds the callback URL, so nothing of ours survives it except a cookie **scoped to cover both hosts** — see below |

**A code that cannot be used never fails the registration.** The account is
created, the grant is not, and the console finds out by asking: `inviteGrant`
answers `null`, and `inviteGrantStatus(code:)` answers *why* — `EXPIRED`,
`EXHAUSTED`, `DISABLED`, `NOT_FOUND`, `ALREADY_REDEEMED` or `ERROR`, one sentence
each on the screen the sign-up lands on. Anything else would mean a mailing-list
mistake costing a visitor their account.

It takes the code as an argument because nothing persists a refusal: the
redemption writes a row when it succeeds and deliberately nothing when it does
not, so the browser that presented the code is the only thing that still knows
which one it was. Unlike the public lookup it gives the typed reason — the caller
holds a session and already holds the code, so there is nothing left to leak.

Three database constraints make a double grant impossible, and none of them is a
check in application code: the relative `UPDATE … WHERE redemptionCount <
maxRedemptions`, the unique index on `invite_redemptions.userId` ("one grant per
account, ever"), and the ledger's unique `idempotencyKey`,
`invite:<codeId>:<userId>`. See `docs/contracts/data-model.md` invariant 6.

The grant is an ordinary ledger entry, so it shows up on the Credits screen with
its campaign in `reference` — a campaign's spend is answerable from the ledger
alone.

**In the console** (SUP-145) the code is never typed. `/signup` reads `?invite=`,
keeps a copy in `localStorage` so it survives the console's own navigations, and
appends it to whichever sign-up path the deployment offers — the request body for
a password sign-up, `callbackURL` for a magic link, the `cr_invite` cookie before
an OAuth redirect.

That cookie's `Domain` attribute is load-bearing rather than optional. A cookie
written with no `Domain` is *host-only* (RFC 6265 §5.3): the browser returns it to
the exact host that set it and to nothing else. The console and the API are
different hosts on every real deployment, so a host-only `cr_invite` never reaches
`/auth/callback/<provider>` and the grant is lost with no error anywhere. The
console therefore scopes it to the longest suffix the two hosts share —
`router.superprotocol.com` for `console.…` and `api.…` — which is the tightest
scope both can be reached at. Where there is no such suffix (unrelated registrable
domains, or an IP literal) the cookie stays host-only, OAuth sign-up carries no
code, and the post-sign-up screen says so; password and magic-link sign-up are
unaffected, because they carry the code in the request itself. This is the one
attribute no local topology can check — compose and the e2e stack share a host,
the single arrangement where host-only crosses — so it is pinned by a unit test on
the cookie string and by a two-host Playwright case. The form shows what the code is worth before the visitor
commits to anything, and keeps a small "have a code?" input for the one person who
forwarded the mail to their work address and lost the link. After registration the
browser lands on `/credits?welcome=invite`, where the balance is already there and
the grant is the `Invitation credit` row naming the campaign.

## Product analytics

The launch campaign is measured, and the console still makes **no third-party
request** (ADR-006; the taxonomy is `docs/contracts/analytics-events.md`).

```yaml
analytics:
  posthog:
    host: https://eu.i.posthog.com   # POSTHOG_HOST
    requestTimeout: 3s
  ingestPerMinute: 60                # per source address on POST /v1/analytics/events
```

`analytics.posthog.projectKey` is normally set from `POSTHOG_PROJECT_KEY` — a
write-only ingest key, not a secret — which `loadRouterConfig` maps into this
section as its lowest-precedence layer. With no key every event is discarded and
the boot says so once, which is the state of every developer machine and every
test.

**Six of the eight events are captured server-side**, at the boundary where the
fact they report is committed: `signup_completed` and `invite_redeemed` from the
sign-up hook, `api_key_created` from the mutation, `first_request_sent` from the
meter, and SUP-146/SUP-149's two from theirs. Each carries a `uuid` derived from
the row it reports, so a retried hook cannot show as two conversions. Nothing is
ever captured that the database does not already hold: no email, no name, no IP,
no free text, and `$ip: null` on every event.

**The other two are posted by the browser** to `POST /v1/analytics/events`, this
service's own ingest, and validated against the taxonomy's allow-list before they
leave. A browser SDK would have bought those two and written a persistent
identifier to the visitor's device — which is what needs a consent banner, and a
banner in front of the campaign we are measuring costs more than two events are
worth. `signup_started` is captured anonymously and is a volume, never a funnel
step; the two halves of the funnel are joined on `campaign`.

## The second grant, for feedback

When the first $100 runs out the console offers another one in exchange for
telling us how it went (SUP-149). The timing is the whole design: the only moment
an account is demonstrably engaged is the moment it has burned through the grant
and wants more, and feedback collected at any other time is politeness rather
than a roadmap.

```yaml
feedback:
  grantMicros: 100000000        # what a completed form credits
  offerBelowMicros: 5000000     # offer below $5 — before the wall, not after
  minMeteredTokens: 1000        # the account must actually have used the first grant
  tokenTtl: 30m                 # how long the link in the console stays good
  webhooksPerMinute: 60
  form:
    provider: typeform
    url: https://superprotocol.typeform.com/to/XXXXXX
    webhookSecret: ${CR_FEEDBACK_WEBHOOK_SECRET}
```

Without `form` the feature is inert end to end: no offer is made and the webhook
is a hard 404.

**Eligibility is decided in the backend, never in the browser.** All four
conditions have to hold: the account redeemed a first grant, its balance has
fallen below `offerBelowMicros`, it has actually sent requests
(`minMeteredTokens`, so the grant cannot be farmed by an account that never used
the first one), and it has not already taken a feedback grant. The console asks
`feedbackOffer` and renders what it is told; it never computes eligibility from
the balance it happens to be holding.

**The form is a third party's, so the link carries a signed statement rather than
an identity.** `feedbackOffer` returns the form URL with a hidden field `t`: an
HMAC over user id, workspace id and issue time, valid for `tokenTtl` — minutes,
not days, because its only job is to survive the walk from the console to the
submit button. A raw user id there would be a way to mint $100 into a stranger's
account by typing theirs into a public form.

**The submission comes back through `POST /v1/webhooks/typeform`**, which
verifies the provider's own HMAC over the raw bytes *and* our token before
anything is written, then applies the grant through the same ledger path an
invitation uses — `kind: grant`, `idempotencyKey` `feedback:<userId>`,
`reference` `feedback` so the Credits screen can name its origin. Everything is
replay-safe: a webhook delivered twice grants once, and a token used twice grants
once. See `docs/contracts/data-model.md` invariant 7.

**The answers are stored here too, not only at the provider.** A question asked
in a form we might stop paying for should not take its answers with it, so every
verified submission is kept — credited or refused — in `feedback_submissions`.
The hidden token is not: a credential in an analytics table is a credential in
every backup of it.

**Setting the form up.** No agent and no laptop holds the Typeform credentials.
`.github/workflows/typeform-setup.yml` is a `workflow_dispatch` job that creates
or updates the form from `docs/feedback-form.json`, mints a fresh
`TYPEFORM_WEBHOOK_SECRET`, registers the webhook against this deployment's URL,
and writes the secret back as a repository secret and into the deployment
environment. Re-running it rotates the secret and re-points the webhook; the form
itself is matched by title, so the questions can be edited in Typeform's own
editor without the job undoing them.

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
