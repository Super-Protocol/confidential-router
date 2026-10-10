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
- [Sign-in by emailed code](#sign-in-by-emailed-code)
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
  - name: qwen25-72b
    hostname: qwen25-72b.tee.swarm.cloud
    tee: AMD SEV-SNP
    # What this endpoint is supposed to run, pinned by digest. The console's
    # attestation panel compares it against the digests in the endpoint's signed
    # deployment evidence and marks anything the list does not cover.
    declaredImages:
      - name: ghcr.io/super-protocol/router-api
        digest: sha256:1111111111111111111111111111111111111111111111111111111111111111
      - name: ghcr.io/berriai/litellm
        digest: sha256:2222222222222222222222222222222222222222222222222222222222222222
```

`declaredImages` is optional and is a statement of intent, never a verdict — the
same kind of thing as `tee`. It exists so the comparison the console makes has
two independent sides: the signed snapshot says what the deployment *runs*, this
list says what it is *supposed to* run, and comparing the snapshot against
digests derived from the same snapshot would prove nothing. Leaving it out is a
distinct answer from declaring an empty list: omitted, the panel reports that
nothing was declared and paints no image green; `declaredImages: []` means the
endpoint is declared to run nothing, under which every image in the evidence is
undeclared. The shape is the one a marketplace AppDefinition pins a component's
images with (`swarm-marketplace-spec` §2.7), so a listing can become the source
later without the field changing.

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

A one-time code mailed to the address, OAuth, and the deployment's own bootstrap
token. There are no passwords, and no hash is stored (SUP-269). Sessions live in
the database. Better Auth owns four
tables and its own migration (ADR-004).

```yaml
auth:
  baseUrl: https://console.tee.swarm.cloud
  secret: ${CR_API_AUTH_SECRET}          # required in production
  github: { clientId: ${CR_API_GITHUB_CLIENT_ID}, clientSecret: ${CR_API_GITHUB_CLIENT_SECRET} }
  google: { clientId: ${CR_API_GOOGLE_CLIENT_ID}, clientSecret: ${CR_API_GOOGLE_CLIENT_SECRET} }
  sessionMaxAge: 2160h                   # 90 days, rolling
  magicLink:
    enabled: false                       # a link beside the code; default: while `mail` has a provider

mail:
  provider: smtp                         # none | console | resend | smtp
  from: no-reply@tee.swarm.cloud
  smtp: { host: smtp.example.com, port: 587, security: starttls, user: …, password: ${CR_API_SMTP_PASSWORD} }
```

[Sign-in by emailed code](#sign-in-by-emailed-code) is on wherever
[mail](#mail) can be sent. A one-time *link* is offered beside it unless
`magicLink.enabled: false`, which is what the marketplace listing sets. With
`mail.provider: none` both are off altogether — their routes are not mounted —
and the deployment signs in by OAuth, if configured, and the bootstrap token.

A session lasts `auth.sessionMaxAge` without being used and is extended while it
is: ninety days by default, as a persistent cookie, so closing the browser does
not sign anyone out.

Every new user gets a personal workspace on first sign-in. `/v1` takes no
cookies and no query parameters — a `Bearer sk-tee-v1-…` key, and nothing else.
Only `sha256(key)` is stored; the plaintext exists for the length of one GraphQL
response.

The console asks `signInOptions` — the one public query it makes before there is
a session — for which of these paths this deployment actually offers, and renders
only those: `emailCode` (with `emailCodeLength`), `magicLink`, `github`,
`google`, `bootstrap` and `adminRecovery`. A "Continue with GitHub" button on a
deployment with no GitHub app can only end in an error.

## Mail

Every transactional mail — the sign-in code, the sign-in link where one is
offered, the welcome mail after a sign-up — is rendered from one template set
(`apps/router-api/src/app/mail/templates.ts`: Super Protocol logo, inline CSS,
a dark-mode block, and a plain-text part with the same content) and sent through
one provider (SUP-269):

| `mail.provider` | Sends through | Notes |
|---|---|---|
| `none` | nothing | No sign-in by code or link — the deployment is bootstrap-token-only; no welcome mail. |
| `console` | the log | Development only: refused in production, because a code in a log is a sign-in for anyone with the log. |
| `resend` | the Resend HTTP API | Needs `mail.resendApiKey`. |
| `smtp` | any SMTP server | `mail.smtp`: `host`, `port`, `security` (`starttls` — the default, upgrade required; `tls` — port 465; `none`), `user`, `password`. |

Where a mail names the console — the welcome mail's button, the footer of every
mail — it is `mail.consoleUrl`, by default the first entry of
`server.validClientOrigins`, never the API. The sign-in code mail carries no
link at all: the code is typed into the page that asked for it.

`mail` is new; before it the provider lived in `auth.magicLink`
(`mailer`, `from`, `resendApiKey`). Those keys are still read whenever
`mail.provider` is unset, so an older config boots unchanged.

**Deliverability is the operator's.** Mail from `mail.from` reaches an inbox only
if that domain publishes SPF and DKIM records that cover the provider sending it
(and ideally DMARC). That is DNS this deployment cannot write.

**Reachability is reported, not assumed.** With `smtp`, the API connects and
authenticates once at boot without sending anything, and `/health` carries the
outcome as `mail: { provider, state, reason }` — `ok`, or `failing` with
`unreachable` (no connection at all), `auth_failed` or `rejected`. Every later
send updates it. It never makes `/health` itself fail: a lost welcome mail is
not an outage. The log line says which host and port, and never the password.
On a Swarm cluster space, outbound connections to public addresses are open and
private ranges are not, so the SMTP host has to resolve to a public address;
some clouds also block outbound port 25, which is what 587 and 465 are for.

## Sign-in by emailed code

How an account signs in, and how one is created (SUP-269). On wherever
`mail.provider` is not `none`.

```yaml
auth:
  emailCode:
    ttl: 10m                      # single-use either way
    attempts: 3                   # wrong guesses before a code is void
    requestsPerMinute: 10         # per source address; asking and trying counted apart
    mailsPerAddressPerHour: 10    # per recipient; beyond it, nothing is sent
```

1. `POST /auth/email-otp/send-verification-otp {"email": …, "type": "sign-in"}`
   answers `200 {"success": true}` for every address, account or not, and mails
   it a six-digit code. Only a digest of the code is stored.
2. `POST /auth/sign-in/email-otp {"email": …, "otp": …}` answers with the
   session cookie. The code is consumed: a second use, a wrong code and an
   expired one are all a 400 (`INVALID_OTP`, `OTP_EXPIRED`), and after `attempts`
   wrong guesses the code is void (`TOO_MANY_ATTEMPTS`).

**Sign-up is the same two requests.** An address with no account is created when
its code comes back; the second request may carry `name`, and `inviteCode` for
[an invitation](#invitation-codes). On an
[invite-only](#invite-only-registration) deployment that is the whole rule: an
unknown address needs a valid, unredeemed invitation *and* the code, in that one
request, and an existing account needs only the code. A refused sign-up has
still spent its code, so the console checks the invitation before it asks for
one.

**What it does not tell anyone.** The send route answers identically for every
address and is rate-limited per source (429). One recipient is mailed at most
`mailsPerAddressPerHour` codes — past that the answer is the same 200 and
nothing is sent, so the limit cannot be used to learn or to silence anything. A
send the mail server refused is also a 200: it shows in the log and in
`/health`, not to the requester.

**Passwords are gone.** `/auth/sign-up/email`, `/auth/sign-in/email`,
`/auth/change-password`, `/auth/request-password-reset` and
`/auth/reset-password` are 404 on every deployment. `auth.password` is still
accepted in the configuration and ignored, with a warning at boot, so a config
written for an older version loads. The password hashes older versions stored
are deleted right after the auth migrations — at boot where migrations run at
boot, and by `router-api-migrate` otherwise. The accounts themselves are
untouched: the same address signs in with a mailed code, and the first time it
does its address becomes a verified one, which it never was under a password.

## First sign-in on a fresh deployment

A deployment can be brought up with no mailer and no OAuth app — a marketplace
install is exactly that — and then none of the paths above can produce the first
account. `auth.bootstrapToken` is the way in:

```yaml
auth:
  bootstrapToken: ${CR_API_BOOTSTRAP_TOKEN}   # at least 16 characters; blank counts as unset
  bootstrapEmail: admin@example.com           # default: admin@confidential-router.local
mail:
  provider: none                              # no mail on this deployment
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

- **One account.** The token creates an account exactly once, on an empty
  deployment, at `bootstrapEmail`. `user.email` is unique, so two simultaneous
  requests cannot make two.
- **Break-glass afterwards (SUP-269).** Once that account exists, the same token
  signs back into it — into that account and no other, and it creates nothing.
  Sign-in is otherwise a code mailed to the address, so this is the
  administrator's way in when no code can be delivered: a deployment with
  `mail.provider: none`, or one whose mail server is down. The console offers it
  as "Administrator: use the first-sign-in token" while
  `signInOptions.adminRecovery` is true. Unset `bootstrapToken` to close it.
- **404, not 403.** With no token configured the endpoint is not mounted at all;
  on a deployment that has users but not the bootstrap account it answers 404.
  Neither state confirms to an anonymous caller that a bootstrap token exists. A
  *wrong* token where the token could do something answers 401, because at that
  point availability is already public (`signInOptions`) and a typo deserves a
  retry.
- **Constant-time, and never logged.** The token is compared through SHA-256
  digests, so neither its value nor its length leaks through timing, and it is
  not written to the log, echoed in a response or exposed by any query.
- **Rate-limited** to five attempts a minute per source, in production.

Afterwards the account is an ordinary one: it owns its workspace and it is the
account a code mailed to `bootstrapEmail` signs into — so `bootstrapEmail` should
be a mailbox somebody reads on any deployment that has a mailer. It is also the
*only* account the token can make or open: everyone else gets in through
[an emailed code](#sign-in-by-emailed-code) or OAuth. There is no separate
"admin" role in the workspace model — the operator-only screens are gated on
`auth.adminEmails`.

**A deployment with `mail.provider: none` is bootstrap-token-only.** Nobody but
the bootstrap account can sign in unless an OAuth app is configured, because
there is no other credential: no code can be mailed and there are no passwords.
That is a workable evaluation setup for one person and nothing more; configure
[mail](#mail) to let anyone else in.

## Billing and Stripe

Credits are an append-only ledger; `workspaces.balanceMicros` is its running
sum, written only in the same transaction as the row that moved it. A correction
is a new row with a negative amount, never an edit. Every write carries an
idempotency key, so a redelivered webhook or a retried debit cannot charge
twice.

```yaml
billing:
  provider: auto                       # auto | stripe | manual | disabled
  minTopUpMicros: 5000000              # $5
  maxTopUpMicros: 10000000000          # $10 000, the ceiling on one checkout
  allowOverdraftMicros: 0              # how far a generation may push a balance negative
  signupGrantMicros: 0                 # credit granted to every new account (ledger `grant`, reference `signup`); 0 disables
  checkoutReturnUrl: https://console.example.com/credits
  autoTopUpCooldown: 1h                # floor between two automatic top-ups of one workspace
  stripe:
    secretKey: ${CR_API_STRIPE_SECRET_KEY}
    webhookSecret: ${CR_API_STRIPE_WEBHOOK_SECRET}
    currency: usd
```

The payment provider sits behind an interface (ADR-005), and `billing.provider`
says which one binds. Stripe is the only one that takes money, and there are no
crypto payments.

On a developer's machine the module binds a **manual provider** instead:
`createCheckout` hands back a link, following the link *is* the payment, and the
redirect credits the ledger — the same redirect-then-confirm sequence Stripe
drives, without a card or a network. Because that is credit out of nothing, two
independent conditions have to hold before it binds: `NODE_ENV` is not
`production`, **and** `server.publicBaseUrl` is a loopback address. Either one
failing is a refusal to boot. `NODE_ENV` alone used to be the test, and a
deployment that set it to `development` shipped an unbounded free-credit button
to every account holder (SUP-167).

A deployment that does not sell credit sets `provider: disabled`. Checkout is
then refused outright, the console hides its buy panel, and credit arrives the
way it was meant to — invitation codes, the feedback grant, and an operator's
`credits grant`, none of which go through a provider.

`maxTopUpMicros` bounds one checkout. It is not a business rule but a blast
radius: whatever the mutation accepts is what a single call can ask for.

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

## Sign-up credit

`billing.signupGrantMicros` credits every new account at registration — a ledger
`grant` with `reference` `signup` and `idempotencyKey` `signup:<userId>`, written
by `SignUpGrantService` in the same account-creation hook as the invitation grant
(SUP-249). `0`, the schema default, turns it off; the marketplace listing exposes
it as `signupGrantUsd` with its own default of 20. It **stacks** with an
invitation: a visitor with a $100 code on a deployment granting $20 at sign-up
starts at $120. Like the invitation grant it never fails a registration, and each
account gets it once however often the hook runs. It is an operator's deploy-time
decision and not a purchase, so none of the billing provider's no-minting rules
(SUP-167) are touched. A production launch that wants credit to come only from
invitations sets it to `0`. See `docs/contracts/data-model.md` invariant 8.

**Mind what it costs on an open deployment.** An emailed code proves a mailbox, and
mailboxes are free, so with registration open each throwaway address collects the credit:
the grant is once per *account*, not per person. Pair a non-zero value with
invite-only registration (`auth.requireInviteForSignUp`) where that matters, or
keep it small enough to be an evaluation allowance rather than a prize.

## Invitation codes

A mailed campaign hands out credit without the recipient ever typing a code
(SUP-140). The invitation is a link — `https://router.superprotocol.com/?invite=ABCD-EFGH-JKMN&utm_…` —
the landing page carries the code to sign-up, and creating the account is what
spends it.

```yaml
invites:
  landingBaseUrl: https://router.superprotocol.com   # where generated links point (CLI and console)
  lookupsPerMinute: 30                               # per source address on the public lookup
auth:
  adminEmails: [ops@example.com]                     # who may issue, withdraw and see invitations
```

Nothing switches the feature on: with no codes generated it is inert.

**Generating a campaign.** Two surfaces, one generator. The CLI is for a large
mailing; the console's **Administration → Invitations** section (SUP-268) is for
the deployment that is published and invite-only, where there is no shell to run
the CLI in. The console mints behind `auth.adminEmails`, at most 1,000 codes and
$10,000 per code per call (a fat-finger guard, not a policy), and records the
operator on each row (`invite_codes.issuedByUserId`; null means the CLI). It shows
the batch once with copy-all and the same `code,url` CSV the CLI writes, lists
every code — masked until revealed — with who redeemed it, lists every account
with its origin (invitation / bootstrap / open sign-up), and charts sign-ups and
redemptions from this database. No code value is ever logged: the audit lines name
the operator, the campaign and the row id.

**Moving codes between deployments** (SUP-272). A redeploy starts from an empty
database, and codes that were already mailed have to keep working on it. The Codes
tab has **Export CSV** and **Import CSV** for that — both behind
`auth.adminEmails`, both audit-logged with the operator and the counts, neither
ever logging a code. The file holds live codes: handle it like the mailing itself.

- *Export* writes every code, or the ones the tab's campaign / status filter
  shows: `code` (full value), `url`, `campaign`, `grantUsd`, `status`
  (`active` / `redeemed` / `expired` / `withdrawn`), `redeemedByEmail`,
  `redeemedAt`, `createdAt`, then `expiresAt`, `withdrawnAt`, `maxRedemptions`
  and `note` — the four a code needs to mean the same thing on the other side. A
  shared code lists each redemption, `;`-separated, in the two `redeemed…` columns.
- *Import* takes that file and nothing else — another header is refused. It runs
  as a **dry run first**: per-status counts, duplicates, malformed rows by row
  number, nothing written. Confirming sends the file's SHA-256 back, so what is
  imported is the file that was looked at. The write is one transaction; a file
  with a single malformed row writes nothing.
- An unredeemed code arrives live with its exact value, credit, seats and expiry.
  A redeemed or withdrawn one arrives **already spent** — it can never be
  redeemed on the new deployment — and who redeemed it is kept on the code,
  matched to an account by email whenever that address exists here. No credit is
  granted for a carried redemption, and nobody's balance moves.
- A code already present is skipped and reported, never overwritten.
- `url` is rebuilt from this deployment's `invites.landingBaseUrl` on every
  export; the import does not read it. Who issued a code does not travel — the
  operator's account is the other deployment's.

The same two routes without a browser, with an operator's session cookie:

```bash
curl -b "$COOKIE" -o codes.csv "$API/admin/invite-codes/export.csv"
curl -b "$COOKIE" -H 'Content-Type: text/csv' --data-binary @codes.csv "$API/admin/invite-codes/import"
curl -b "$COOKIE" -H 'Content-Type: text/csv' --data-binary @codes.csv \
  "$API/admin/invite-codes/import?apply=true&expect=<sha256 from the dry run>"
```

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

**A code that cannot be used never fails the registration** — unless the
deployment asked for the opposite; see *Invite-only registration* below. The
account is created, the grant is not, and the console finds out by asking: `inviteGrant`
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
an emailed-code sign-up, `callbackURL` for a magic link, the `cr_invite` cookie before
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
code, and the post-sign-up screen says so; emailed-code and magic-link sign-up are
unaffected, because they carry the code in the request itself. This is the one
attribute no local topology can check — compose and the e2e stack share a host,
the single arrangement where host-only crosses — so it is pinned by a unit test on
the cookie string and by a two-host Playwright case. The form shows what the code is worth before the visitor
commits to anything, and keeps a small "have a code?" input for the one person who
forwarded the mail to their work address and lost the link. After registration the
browser lands on `/credits?welcome=invite`, where the balance is already there and
the grant is the `Invitation credit` row naming the campaign.

### Invite-only registration

A campaign running grants-only wants the stronger rule: **an account must not be
creatable without a valid, unredeemed code** (SUP-173). One setting, off
everywhere by default:

```yaml
auth:
  requireInviteForSignUp: true
```

While it is on, every sign-up path — emailed code, magic link, OAuth callback — is
refused before the `user` row exists unless the request carries a code that is
usable at that moment. The check runs in Better Auth's
`databaseHooks.user.create.before`, which is the one seam all three paths pass
through and the only one that can tell a sign-up from a sign-in on the two where a
single request does both. Two things it deliberately does **not** change: signing
in to an existing account, which is untouched, and `POST /auth/bootstrap`, which
is the operator claiming their own deployment and could never have been mailed a
code.

The refusal is typed, because "you need an invitation" and "yours has been used"
send a person to two different places:

| Code | When | HTTP |
| --- | --- | --- |
| `invite_required` | the request carried no code at all | 403 |
| `invite_already_claimed` | the code exists and its seats are gone | 403 |
| `invite_expired_or_unknown` | never issued, expired, or withdrawn | 403 |

Three and not five. `already_claimed` is the one refusal that confirms a code was
real, and a spent code is worth nothing to whoever confirmed it; merging expired,
withdrawn and never-issued keeps the endpoint from telling a guessed code from a
real one, and keeps a withdrawal from announcing itself. The public lookup
`GET /v1/invites/:code` is unchanged and still collapses every unusable code into
one `unavailable`.

An emailed-code sign-up reads the refusal out of the 403 body (`{ code, message }`). The
other two finish as navigations and cannot be answered with a body, so Better Auth
redirects to the error callback the console named, with `?error=<code>` on it —
the same three values either way, which is what lets the console have one set of
copy. `signInOptions { inviteRequired }` reports the setting, so the sign-up screen
says "registration is by invitation", keeps the code input open, and renders each
refusal as its own alert.

**The typed refusal has to be reachable from a browser** (SUP-176). The screen's
pre-check calls the public lookup, which answers one `unavailable` for a spent
code and for one that was never issued alike — so while the console held the
submit button behind that answer, the two refusals that read differently were
readable only by `curl`, and the visitor whose link really had been spent got a
sentence that opened by suggesting a typo. So the button is held only while the
lookup has *no* answer — in flight, or unreachable — and a settled `unavailable`
submits: the gate runs before the insert, so the 403 costs nothing and is the one
place the distinction exists. It is not a new oracle either, because that POST
already answers the three codes to any caller, at the price of a mailed code
per guess; the free `GET /v1/invites/:code` stays collapsed.

**One window the check does not cover.** The pre-check is a read, and the seat is
still claimed by the atomic `UPDATE` inside the grant that follows the insert. It
has to be: Better Auth holds an open read transaction across the hook, and a write
from a second connection inside it is refused with `SQLITE_BUSY` immediately — in
WAL as well as in the default journal mode, because a read snapshot cannot be
upgraded past another connection's commit. So two sign-ups submitted within
milliseconds of each other **on the same code** both get an account and only one
gets the credit. Every other way of presenting an unusable code is refused before
anything is created, and the loser of that race is logged by
`SignUpProvisioning` — on an invite-only deployment that WARN is the only way an
account without credit can come into being.

**Withdrawing a code.** A code that turns up on a mailing list, a forum or a
screenshot has to be retractable in one command, and a campaign that was mailed by
mistake has to be retractable whole (SUP-159):

```bash
node apps/router-api/dist/cli/invites.js disable --code ABCD-EFGH-JKMN
node apps/router-api/dist/cli/invites.js disable --campaign launch-2026-10-devs --unspent-only
node apps/router-api/dist/cli/invites.js restore --campaign launch-2026-10-devs
```

Each prints how many codes it changed — `withdrew 4996 of 5000 codes (2 already
withdrawn, 2 spent and left in circulation)` — and exits `1` when the target
matched nothing, so a script can tell a closed leak from a mistyped code. Running
`disable` twice is not an error and does not move the timestamp that records when
the code was retired.

`restore --campaign` clears **every** withdrawal in the campaign, including a code
retired on its own for a leak earlier: the column records that a code is withdrawn,
not why. Read the counts before running it — `restored 4998 of 5000` on a campaign
you only meant to un-disable wholesale is the leak back in circulation — and
withdraw that code again by `--code` afterwards if it was one of them.

**A withdrawal never touches credit already granted.** `disabledAt` is read when a
seat is claimed and nowhere else, so no balance, no `credit_transactions` row and
no `invite_redemptions` row is affected: retiring a campaign mid-flight stops the
*next* sign-up and leaves every account that already redeemed exactly as it was.
`--unspent-only` is about tidiness rather than safety — it keeps `disabledAt`
meaning "an operator retired this", so a campaign's disabled count stays readable
afterwards.

**On a cluster whose space is published there is no shell**, which is why the same
two operations are also console mutations:

```graphql
mutation { disableInviteCodes(input: { code: "ABCD-EFGH-JKMN" }) { target matched withdrawn } }
mutation { restoreInviteCodes(input: { campaign: "launch-2026-10-devs" }) { restored } }
```

Both are behind `auth.adminEmails`, like `inviteCampaigns`, and both write a WARN
naming the operator — on a frozen deployment the container log is the audit trail.
Withdrawal has an API where *minting* deliberately does not, and the asymmetry
runs in the safe direction: generating codes creates credit and stays a CLI behind
database access, while this only ever stops it. A kill switch that cannot be pulled
on the cluster the codes were mailed for is not a kill switch.

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
