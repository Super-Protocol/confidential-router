# Router API contract — OpenAI-compatible REST subset

Base URL: `https://<endpoint-hostname>/v1` (direct) or `http://127.0.0.1:<port>/v1` (through the
gatekeeper — same paths, same bodies; the gatekeeper is a transparent forward proxy). Implemented by
`apps/router-api` (SUP-73); the contract is the OpenAI API where specified and silent where not.

## Authentication

- `Authorization: Bearer sk-tee-v1-<43 chars base64url>` on every `/v1/*` request. No cookies, no query
  params. Missing/invalid → `401 invalid_api_key`; revoked/expired → `401 api_key_revoked` /
  `api_key_expired`.
- Key format: prefix `sk-tee-v1-` + 32 random bytes base64url. Stored as `sha256(key)` + first 12 chars
  (`sk-tee-v1-4f7a…`) for display. Shown in full exactly once, at creation.
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
| `GET /.well-known/swarm-evidence` | platform | served by the platform ingress, not by router-api |

Unsupported OpenAI paths return `404 {"error":{"type":"invalid_request_error","code":"not_found"}}`.

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
| 503 | `gatekeeper_error` | `attestation_failed` — emitted by the **gatekeeper**, never by the router |
| 500 | `server_error` | `internal` |

Rate limits are per API key (`requestsPerMinute`, `tokensPerMinute`, from key settings or workspace
defaults).

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

## Compatibility promise

`v1` paths and response shapes are stable; extension fields only ever get added. Breaking changes → `/v2`.
