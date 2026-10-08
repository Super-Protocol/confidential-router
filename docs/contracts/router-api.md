# Router API contract — OpenAI-compatible REST subset

Base URL: `https://<endpoint-hostname>/v1` (direct) or `http://127.0.0.1:<port>/v1` (through the
gatekeeper — same paths, same bodies; the gatekeeper is a transparent forward proxy). Implemented by
`apps/router-api` (SUP-73); the contract is the OpenAI API where specified and silent where not.

## Authentication

- `Authorization: Bearer sk-tee-v1-<43 chars base64url>` on every `/v1/*` request. No cookies, no query
  params. Missing/invalid → `401 invalid_api_key`; revoked/expired → `401 api_key_revoked` /
  `api_key_expired`.
- Key format: prefix `sk-tee-v1-` + 32 random bytes base64url. Stored as `sha256(key)` + first 12 chars
  (`sk-tee-v1-4f`) for display. Shown in full exactly once, at creation.
- Optional `X-Request-Id` (echoed) and `X-Confidential-Router-Generation-Id` (response) headers.

## Endpoints

| Method & path | Status | Notes |
| --- | --- | --- |
| `POST /v1/chat/completions` | required | non-stream and `stream: true` (SSE) |
| `GET /v1/models` | required | OpenAI list shape + extension fields |
| `GET /v1/models/{id}` | required | single model |
| `POST /v1/completions` | required | legacy text completions, same streaming rules |
| `POST /v1/embeddings` | optional | only if the model's `capabilities` include `embeddings` |
| `GET /v1/generation?id=` | required | metering record of one generation (OpenRouter-style) |
| `GET /v1/evidence` | required | raw passthrough of **this deployment's** latest published bundle; no key |
| `GET /v1/evidence/{endpoint}` | required | the same, for a named endpoint — or for a registered external upstream; no key |
| `GET /v1/invites/{code}` | extension | **not OpenAI**: what an invitation code grants. No key, rate-limited per source address |
| `POST /v1/webhooks/typeform` | extension | **not OpenAI**: feedback form submissions. No key; two signatures instead |
| `GET /.well-known/swarm-evidence` | platform | served by the platform ingress, not by router-api — **and with no CORS headers**, so a browser cannot read it cross-origin |

Unsupported OpenAI paths return `404 {"error":{"type":"invalid_request_error","code":"not_found"}}`.

### `GET /v1/invites/{code}`

The one path under `/v1` that is neither OpenAI-compatible nor key-authenticated, because its caller has
not got an account yet: the landing page and the sign-up form use it to say "your $100 credit is ready"
before the visitor commits to anything. Answers Nest's ordinary JSON, not the OpenAI envelope. Always
`Cache-Control: no-store` — a grant that has just been spent must stop reading as available.

The code is matched case-insensitively with separators ignored, so `abcd-efgh-jkmn`, `ABCDEFGHJKMN` and
`ABCD EFGH JKMN` are one code.

```json
{ "valid": true, "grantMicros": "100000000", "campaign": "launch-2026-10-devs" }
{ "valid": false, "reason": "unavailable" }
```

`unavailable` is the **only** reason it ever gives. Expired, exhausted, withdrawn and never-existed are one
answer here on purpose: distinguishing them would confirm to an anonymous caller that a guessed code is a
real one, which is most of the work of stealing a grant. Operators get the real reason from
`node dist/cli/invites.js stats` and the `inviteCampaigns` query.

`429` with `Retry-After` past `invites.lookupsPerMinute` per source address, on a budget of its own — a
tenant's `/v1` traffic and the landing page's lookups do not spend each other's.

Redemption is **not** on this surface, and there is no endpoint for it: a code is spent inside account
creation (`docs/router.md`, "Invitation codes"), which is what makes a grant unreplayable.

### `POST /v1/analytics/events`

The console's first-party analytics ingest. Unauthenticated or session-authenticated, `Cache-Control:
no-store`, answers `202` with an empty body.

```json
{ "event": "signup_started", "properties": { "has_invite": true, "campaign": "launch-2026-10-devs", "entry": "landing_cta" } }
```

It exists so the console makes **no third-party request**: `posthog-js` in the bundle would have bought two
events and written a persistent identifier to the visitor's device, which is what ePrivacy Art. 5(3)
attaches consent to (ADR-006 §3). The other six console events are facts the database already holds and are
captured server-side.

- `event` must be one of `CONSOLE_INGEST_EVENTS` — `signup_started`, `feedback_form_opened`. Anything else
  is `400`: an event the server can derive is one a client must not assert.
- `properties` are dropped unless the taxonomy declares them for that event, and unless they are short
  scalars. The allow-list is what keeps a public endpoint from being a way to write arbitrary rows into our
  analytics.
- `distinct_id`, the timestamp and the event `uuid` are the server's. `signup_started` is captured
  anonymously whatever session the request carries; `feedback_form_opened` needs one and answers `401`
  without it.
- `429` with `Retry-After` past `analytics.ingestPerMinute` per source address, on a budget of its own.

### `POST /v1/webhooks/typeform`

Where the feedback form posts a submission, and the only way the second $100 is ever applied
(`docs/router.md`, "The second grant"). Like the invitation lookup it lives under `/v1` without being
OpenAI-compatible or key-authenticated, and is registered before the `/v1` fallback.

Authenticated by **two** signatures and by nothing else:

- `Typeform-Signature: sha256=<base64>`, an HMAC over the exact bytes of the body — which is why the raw
  body parser is mounted on this path ahead of the JSON one, as it is for the Stripe webhook;
- our own short-lived token in the submission's hidden field `t`, an HMAC over user id, workspace id and
  issue time. It says *which account* to credit. Without it a public form would be a way to mint $100 into
  a stranger's account by typing their id into it.

Either one missing, forged or expired answers `401` and grants nothing; the response says which of the two
failed to nobody, because the only callers are the provider, which does not read it, and someone probing.

Once both check out the answer is always `200`, whatever it decided — a provider that does not read a 2xx
redelivers for days:

```json
{ "outcome": "granted" }
{ "outcome": "replayed" }                              // the same submission, delivered again
{ "outcome": "refused", "reason": "already_granted" }  // or not_eligible / unknown_account / error
{ "outcome": "ignored" }                               // an event that is not a form submission
```

A hard `404` where `feedback.form` is unset: an endpoint that answered would be telling a prober that this
deployment has a grant to give away. `429` with `Retry-After` past `feedback.webhooksPerMinute` per source
address — the signature is the authority, and the budget only stops an unsigned flood from spending the
service's time verifying HMACs.

### `POST /v1/chat/completions`

Request: OpenAI schema. Honoured fields: `model`, `messages`, `stream`, `stream_options.include_usage`,
`max_tokens` / `max_completion_tokens`, `temperature`, `top_p`, `stop`, `n` (=1 only), `seed`,
`response_format`, `tools`, `tool_choice`, `user`. Unknown fields are forwarded to LiteLLM unchanged;
the router never inspects or stores `messages`.

Response (non-stream): OpenAI `chat.completion` object. `id` is the router's generation id
(`gen-<ulid>`), `model` echoes the router model id, `usage` is authoritative (from the backend when
present, otherwise tokenised by the router) and extended:

```json
{
  "id": "gen-01J6…",
  "object": "chat.completion",
  "created": 1756550000,
  "model": "meta/llama-3.3-70b-instruct:tdx",
  "choices": [ { "index": 0, "message": { "role": "assistant", "content": "…" }, "finish_reason": "stop" } ],
  "usage": {
    "prompt_tokens": 5454,
    "completion_tokens": 362,
    "total_tokens": 5816,
    "cost_micros": 5450,
    "endpoint": "llama-33-70b",
    "evidence_digest": "sha256/6b1f…9c04"
  }
}
```

Extension fields live inside `usage` (as OpenRouter does) so OpenAI SDKs ignore them: `cost_micros`
(integer micro-USD debited), `endpoint` (router endpoint name that served it), `evidence_digest` (the
digest the platform had published for that endpoint at generation time, `null` if none — this is
"evidence coverage", a fact about publication, never a verdict).

Streaming: `Content-Type: text/event-stream`, one `data: <chat.completion.chunk JSON>` per event, a final
usage-only chunk (empty `choices`) when `stream_options.include_usage` is true, then `data: [DONE]`.
Heartbeat comment lines (`: ping`) every 15 s while waiting for the first token. The router forwards
chunks as they arrive from LiteLLM (no buffering); through the gatekeeper this is byte-streamed as well
(SUP-71). Errors after the stream started are sent as a last `data:` event with an `error` object, then
`[DONE]`.

`[DONE]` is also where the generation *ends*, for metering: a client that closes the connection once it
has read the terminator has the whole answer and the row is `ok`. Only a client that leaves before it is
metered `aborted` with no `errorCode`, and only a verdict withdrawn under a running stream is metered
`aborted` with `attestation_revoked` (ADR-008, ruling 5). The distinction is load-bearing in both
directions — the official SDK closes the response the instant it sees `[DONE]`, so calling that an abort
would both misprice the Logs screen and leave `aborted` unable to mean "policy cut this short".

### `GET /v1/models`

```json
{ "object": "list", "data": [ {
  "id": "meta/llama-3.3-70b-instruct:tdx", "object": "model", "created": 1756550000, "owned_by": "confidential-router",
  "name": "Llama 3.3 70B Instruct", "context_length": 131072,
  "pricing": { "prompt_per_1m_micros": 280000, "completion_per_1m_micros": 420000 },
  "endpoint": { "name": "llama-33-70b", "hostname": "llama-33-70b.tee.swarm.cloud", "tee": "Intel TDX + H100 CC" },
  "capabilities": ["chat", "completions"]
} ] }
```

Only models within the key's scope are listed.

`endpoint.tee` is the operator-declared TEE label from the router config, and is **absent** for a
model served by an external upstream (ADR-008): nobody declares an upstream's hardware — the admin
API has no field for it (`console-graphql.md`, `ExternalModelInput`) — and this router cannot observe
it, so there is nothing to publish. What it *can* say about an upstream is the measurement a verdict
saw, which the console reads from `ExternalEndpoint.measurementSeen` rather than from the model.

### `GET /v1/evidence` and `GET /v1/evidence/{endpoint}`

`{endpoint}` is an endpoint **name** or **hostname** from the router config, or the **name** of a
registered external endpoint (ADR-008; name or hostname there too). Without one, the route answers for
**this deployment's own** endpoint: the one whose `hostname` is the host of `server.publicBaseUrl`, or —
where that names no endpoint and there is only one — that one. With two or more endpoints and no match
it answers `404` rather than guessing, and the caller names the endpoint it means.

Our own endpoints are resolved first. The two name spaces are separate tables on purpose — a collision
between "a host we publish evidence for" and "a host we verify" would be a trust confusion — so a value
matching both is a misconfiguration, and the safe reading of it is the one where this deployment answers
for itself.

Either way the response is the most recently issued `/.well-known/swarm-evidence` bundle this router has
fetched, **byte for byte as published** (`schemas/swarm-evidence-bundle.schema.json`) — the stored copy is
the publisher's own document, member order included, so hashing this response and hashing what the
platform's gateway serves for the same publication gives the same digest. `Cache-Control: no-store`: a
bundle is re-signed every few minutes and a reader is comparing freshness and digests against the live
host.

For an external endpoint it is specifically the publication **that endpoint's last verdict named**
(`ExternalEndpoint.evidenceDigestSeen`), not merely the newest row the poller holds. Two rules meet
there and both are needed: a fetched upstream bundle is *filed* only when the TLS leaf it claims is the
leaf the egress sidecar pinned, and it is *served* only for the digest a verdict actually observed. A
document from anyone but that upstream was never filed; a real but superseded publication of that
upstream is never handed out. The upstream may well be publishing something newer — that is what the
`503` below covers until the next verdict catches up.

Two refusals, told apart on purpose:

| HTTP | Body | Means |
| --- | --- | --- |
| `404` | Nest's shape, `{"statusCode":404,"message":…}` | no such endpoint — or, on the bare path, this router cannot tell which is its own |
| `503` | `{"statusCode":503,"reason":"evidence_not_fetched","message":…}` | the endpoint exists and nothing has been retrieved for it yet |

They used to be one `404`, which read on the chat's locked composer as the router denying an endpoint it
in fact has (SUP-191). Never an empty `200`: a caller that verifies what it is handed must not have to
tell a bundle from the absence of one.

For an external endpoint the `503` covers three situations and tells a caller none of them apart, on
purpose: no verdict yet, a verdict whose publication this router has not managed to retrieve, and an
upstream that republished between the verdict and the fetch. All three are "there is nothing here this
router is entitled to call current", and none is a statement about the upstream.

An external endpoint's **status does not change what this route does.** A `denied` or `disabled`
upstream's last admitted publication is still relayed, and that is not a claim that the router would
route there now: this surface has never carried a verdict in either direction (ADR-002), and the screens
that do carry one say *denied by this router* in so many words (ADR-008 §1). Refusing here would make
the relay the third place a verdict is expressed and the least legible of the three.

Deliberately unauthenticated: the platform serves the same document publicly on the endpoint's own
hostname, and a user comparing the two should not need an API key. Just as deliberately, the response is
the bundle and nothing else — the router never validates a signature and never reports a verdict
(ADR-002).

That holds for an external upstream too, and the reasoning is the same document-shaped one rather than
an oversight. What is relayed is a JWS the *upstream* publishes at its own public well-known path; this
router adds nothing to it and asserts nothing about it. Ruling 3 on SUP-221 keeps endpoint URLs and
verdict detail out of the anonymous **catalogue**, and that holds — `Model.externalUpstream` is null
without a session. A caller here must already know the endpoint name, and what it learns is a document
its publisher serves to the world.

**This is also the only copy of the document a browser can read.** `/.well-known/swarm-evidence` is
served by the platform's own gateway, which sits below this service's CORS layer and sends no
`Access-Control-Allow-Origin` at all, so a console on `console.…` cannot read the evidence of an API on
`api.…`. These routes are `/v1/*` on the API host and go through `server.validClientOrigins`. Nothing
about authenticity rests on that: the document is a JWS over its own bytes and the browser checks the
signature whichever copy it got.

### `GET /v1/generation?id=gen-…`

Returns the `Generation` record (tokens, cost, model, endpoint, timings, `evidence_digest`) for a
generation owned by the key's workspace. Never any content.

## Errors

OpenAI shape, always JSON, always `Content-Type: application/json`:

```json
{ "error": { "message": "human readable", "type": "invalid_request_error", "code": "model_not_found", "param": "model" } }
```

| HTTP | `type` | `code` |
| --- | --- | --- |
| 400 | `invalid_request_error` | `invalid_json`, `missing_field`, `unsupported_parameter`, `context_length_exceeded` |
| 401 | `authentication_error` | `invalid_api_key`, `api_key_revoked`, `api_key_expired` |
| 402 | `insufficient_credits` | `insufficient_credits`, `key_spend_limit_reached` |
| 403 | `permission_error` | `model_not_in_key_scope` |
| 404 | `invalid_request_error` | `model_not_found`, `not_found` |
| 429 | `rate_limit_error` | `rate_limit_exceeded` (+ `Retry-After`, `X-RateLimit-Limit/Remaining/Reset`) |
| 502 | `upstream_error` | `backend_unavailable`, `backend_error` |
| 503 | `gatekeeper_error` | `attestation_failed`, `attestation_revoked` — see below |
| 500 | `server_error` | `internal` |

`gatekeeper_error` used to be emitted by the **gatekeeper** and never by the router. That changed with
ADR-008: for a model on an **external endpoint** — one in another deployment, registered by an admin at
runtime — the router *is* a gatekeeper, and says so in the same vocabulary a client already branches on.

- **`attestation_failed`** — nothing was sent. Raised when no live verdict admits the endpoint serving
  the requested model, either by the router's own admission check (the model is registered but its
  endpoint is `pending` or `denied`) or by the egress sidecar's fail-closed 503 one hop later, which
  covers the window between a verdict flip and the status poll that projects it. The message names the
  endpoint and the stage that denied. `Cache-Control: no-store`, because a cached refusal would outlive
  the verdict that caused it.
- **`attestation_revoked`** — the request was admitted and then policy changed: the verdict was
  withdrawn while the generation was streaming, so the sidecar closed the connection under it. The
  stream ends with this error as its last `data:` event followed by `[DONE]`, and the generation is
  metered `aborted` with the tokens already delivered. A client retrying a flaky backend should not
  retry this until an admin acts.

A model whose endpoint holds no verdict is also **absent** from `GET /v1/models` and answers 404 on
`GET /v1/models/{id}` — it is not listed-but-broken (ADR-008, decision 5). Everything else about an
external model's request is identical to a built-in's: the same rate-limit buckets, the same metering
row, the same SSE relay, the same response shape. `usage.endpoint` names the external endpoint and
`usage.evidence_digest` carries the upstream digest the admitting verdict observed.

Rate limits are four minute buckets, checked on admission in this order: requests per key, requests per
workspace, tokens per key, tokens per workspace. `requestsPerMinute` / `tokensPerMinute` come from the key
where it sets them and from `rateLimits.*` otherwise; the workspace buckets always use `rateLimits.*`, so
minting more keys does not buy a tenant more budget. Token cost is unknown until the model answers, so the
token buckets are only checked for being empty on admission and debited with the real usage afterwards — a
request may overshoot by its own size, never by more.

## Metering

Every accepted request creates a `Generation` (see `data-model.md`) at completion (or at abort, with
what was counted). Debit = `prompt_tokens × pricing.prompt_per_1m_micros / 1e6 + completion_tokens ×
pricing.completion_per_1m_micros / 1e6`, rounded up to 1 micro-USD, written as one `CreditTransaction`
(`kind: usage`, `reference: generationId`).

## Router ↔ LiteLLM

`router.yaml → backends.litellm.{baseUrl, apiKey}`; the router forwards `/v1/chat/completions`,
`/v1/completions`, `/v1/embeddings` to LiteLLM with `model` rewritten to `models[].litellmModel`, adds
`Authorization: Bearer <litellm key>` and `x-litellm-metadata` with the generation id; timeouts
`backends.litellm.{connectTimeout, readTimeout}`. Plain HTTP inside the cluster (ADR-002 §4). For CI a mock
LiteLLM (`docker/mock-litellm`) implements the same three routes with canned streaming output.

## Router ↔ an external endpoint

The other forward target, for a model in someone else's deployment (ADR-008 §4). The router posts the
same three routes to `http://127.0.0.1:<listenPort>` — the egress sidecar's loopback listener for that
endpoint, recorded on its `external_endpoints` row — with `model` rewritten to the registered upstream
name and `Authorization: Bearer <upstream API key>` **injected by router-api** from the sealed envelope;
the sidecar passes that header through untouched and holds no credential of its own. Timeouts
`externalEndpoints.{connectTimeout, readTimeout}`.

No `x-litellm-metadata` and no generation id go out: LiteLLM gets one because its logs are inside this
cluster space, and another operator's are not. The sidecar dials the upstream over TLS verified against
the pinned leaf only, never a CA bundle, and it is the only process here that holds a certificate.

## Compatibility promise

`v1` paths and response shapes are stable; extension fields only ever get added. Breaking changes → `/v2`.
