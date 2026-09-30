# ADR-007 — Console chat and its three verification tiers

- **Status:** Accepted
- **Date:** 2026-09-30
- **Decided by:** Denis (SUP-180)

## Context

Everything the product has shipped so far assumes the user installs Gatekeeper. That is the right
answer for production traffic and the wrong answer for a demo: the people we mail an invitation to
want to type a question into a box and see a confidential model answer it, and most of them will
not install a proxy to do that.

So the console gets a chat screen. The moment it exists, two things that were previously simple
stop being simple.

1. **Verification.** ADR-002's one architectural rule is that the *router* never asserts a verdict.
   A page, however, is not the router — it is code running in the user's browser, and it can verify.
   But that page was served *by the deployment it would be verifying*, which makes its verdict
   worth strictly less than the extension's and much less than Gatekeeper's. Presenting all three
   as "verified" would be the most misleading thing the product could say.
2. **The conversation.** A chat has a history. Storing it server-side is a durability and a privacy
   claim at once, and the API surface has never held a byte of prompt text
   (`docs/contracts/data-model.md`, the `Generation` invariant).

## Decision

### 1. The chat is not a special inference path

Messages go to `POST /v1/chat/completions` with a real workspace API key, from the browser, over the
same gateway every other client uses — same guard, same rate limits, same metering, same billing.
There is no console-only inference route and no `sendMessage` mutation. A second path would be a
second thing to audit, and the whole claim of the screen is that it is not privileged.

The key is minted by `chatCredential`, marked `api_keys.purpose = 'console_chat'`, scoped to the
chat-capable catalogue, and short-lived (`chat.credentialTtl`, default 2 h). It is held in the tab's
memory only. Asking for one rotates it: **this user's own** previous chat key in that workspace is
revoked, because its plaintext was shown once and is unrecoverable, so there is nothing to reuse.

Rotation is scoped to `(workspace, user)` and not to the workspace, which is the narrower query on
purpose. A workspace has members; revoking every chat key in it meant one person opening the chat
silently breaking the tab another person had open, for as long as their cached secret would otherwise
have lasted — and a reload only reversed who was broken. Two members chatting at once is the ordinary
case for a demo surface. The browser closes the remaining gap: on `api_key_revoked`,
`api_key_expired` or `invalid_api_key` the screen drops its cached secret and mints **once** more, so
a key that dies under a tab for any other reason — an operator revoking it from the Keys screen, the
same user rotating from a second tab — costs one retry rather than a reload. Refusals a fresh key
would not fix, such as `insufficient_credits`, are not retried.

### 2. Three tiers, three different claims, never blurred

| Tier | Who checks | What it proves | Badge |
| --- | --- | --- | --- |
| 1 | This page, with `@confidential-router/attestation` | The deployment published a fresh, correctly signed bundle whose chain is internally valid and whose signed TLS fingerprint matches the certificate it publishes | "Verified by this page" + "this is self-reported" |
| 2 | The Super Protocol browser extension | The same, checked by code the browser pinned from the web store and that the deployment did not serve | "Independently verified by the extension" |
| 3 | Gatekeeper, on the user's machine | All of the above against the **live** TLS certificate, plus the VM launch measurement rebuilt from Super Protocol's signed `sp-vm` artefacts | "Verify it yourself" |

Tier 1 **gates the composer**: nothing is sent until it passes. Tier 2 is feature-detected over a
tiny versioned `postMessage` protocol and can only *upgrade* the badge or refuse — an absent
extension is never an error and never blocks anything. A tier-2 refusal outranks a tier-1 pass,
because the extension is the less credulous of the two.

Tier 2's answer is accepted on the identity of the channel — `event.source` must be the very window
the request was posted into — and not on the shape of the payload. Every field in a verdict is a
string an attacker can copy, and tier 2 is the only path that reaches the word "independently", so
where the answer came from is the one part that must not be forgeable. `event.origin` is deliberately
not also checked: a same-window post carries this document's own origin, so it adds nothing, and it is
`"null"` inside a sandboxed frame, which would reject a legitimate answer for no gain.

This does not reopen ADR-002. Each tier is the *viewer's own agent* reporting what it did; the
router never learns the answer, stores it, or displays one of its own.

### 3. Tier 1 asks the sp-vm registry, not a trust store

`verifyHostname` in `@confidential-router/attestation` answers "does this chain terminate at a root
in my trust store". A page served by the deployment under test has no independent trust store, and
pinning the root out of the bundle being checked would be a green tick that proves nothing. So the
chat calls the verifier's stages individually and asks the root question of something outside the
deployment: the signed `sp-vm` measurement registry, under an RSA key pinned in the console bundle —
byte-identical to the one `apps/gatekeeper/pkg/attestation/attestedroot/registry.go` pins, so the
page and the gatekeeper accept the same set of images.

Consequence, stated plainly because it is the honest part: the demo cloud publishes
`rootCaTeeQuote: {"status": "not-implemented"}` today, so there is no measurement for the page to
look up and the root check reports **"not established"** — neither a pass nor a failure. Rebuilding
a launch measurement from firmware artefacts is not browser work; that is what tier 3 is for. The
gate does not hold the composer for it, and the panel says so in words.

Evidence is fetched from the endpoint directly where CORS allows it and from this router's public
`GET /v1/evidence/:endpoint` passthrough where it does not. The signature is checked either way, so
a relayed bundle cannot be forged — but it can be staler than what the host serves now, and the
panel says which source answered.

### 4. History stays in the browser until the platform can promise otherwise

Threads live in `localStorage`, one key per workspace, hard-deleted on request. The screen reads
`chatSettings.historyStorage` — today always `BROWSER_LOCAL` — and derives its disclosure copy from
it, so it cannot describe storage that does not exist.

Server-side history waits on **SUP-179**: the router's PostgreSQL is a single replica on a tenant
PVC, and swarm-cloud's `storage-layers.md` says the node state disk is ephemeral by design. Until
someone can say whether that volume survives a node reboot, "stored inside the attested boundary" is
a durability promise nobody has made. `invariants.spec.ts` asserts that `chat_threads` and
`chat_messages` do not exist, so the tables cannot land ahead of the answer.

Until then the exposure of a chat message is *exactly* the exposure of an API request: it travels to
the model over `/v1`, which records tokens, cost and model and no content at all.

### 5. Sanity limits, not business rules

`chat.maxMessageChars`, `chat.maxThreads`, `chat.maxMessagesPerThread` are config, published to the
browser, and enforced where the history lives. They exist so a demo surface cannot become a free
storage service. `chat.enabled: false` removes the screen and refuses `chatCredential`.

## Consequences

- One new nullable column (`api_keys.purpose`) and no new tables.
- The console bundle now imports `@confidential-router/attestation`, which is inside its 200 KB
  gzipped budget (`libs/attestation/src/__tests__/bundle-size.spec.ts`).
- The extension half of tier 2 is a swarm-cloud change (`apps/swarm-chrome-extension`). Until it
  ships, tier 2 reports "no extension detected" everywhere, which is a correct statement.
- A workspace that never opens the chat never has a `console_chat` key.
