# Threat model

Scope: Confidential Router (router-api, router-ui, LiteLLM + model servers in one Swarm Cloud cluster
space) and the user-side Gatekeeper. Companion to ADR-002 and ADR-003.

## Assets

| Asset | Owner | Protection goal |
| --- | --- | --- |
| Prompt and completion content | user | confidentiality from the operator and the platform staff |
| Which deployment served a request (images, config) | user | integrity / verifiability |
| API keys, session cookies | user | secrecy |
| Credit balance, metering counters | user & operator | integrity |
| Platform PKI root key, TLS private keys | platform | secrecy — never leave the TEE |

## Trust boundaries

```
┌─ user's machine ───────────────┐      ┌─ Swarm Cloud cluster space (TEE nodes) ────────────────────┐
│ app ──▶ gatekeeper (verifier)  │ TLS  │ ingress (TLS terminates in TEE) ─▶ router-api ─▶ LiteLLM ─▶ model │
│         trusted roots, pins    │─────▶│ /.well-known/swarm-evidence  (published by the platform)     │
└────────────────────────────────┘      └─────────────────────────────────────────────────────────────┘
                                                   ▲ evidence signed by platform PKI (TEE-attested root)
```

Roots of trust the user accepts, explicitly, in the gatekeeper config:

1. the TEE vendor (hardware attestation behind the platform's root CA — `rootCaTeeQuote`, displayed,
   not yet validated client-side);
2. the platform root certificate (`trustedRoots[]`) — "this cloud is the one I think it is";
3. the **content** of the canonical deployment snapshot whose digest they pin (`trustedEvidence[]`) —
   "this deployment (router + LiteLLM + model images + config) is the one I reviewed".

Nothing else is trusted: not the router operator, not DNS, not the OS trust store (the gatekeeper
handshakes with `InsecureSkipVerify` and relies on channel binding to the published fingerprint instead).

## What the router can see

- Request metadata: API key id, model, timestamps, token counts, time-to-first-token, client IP, request
  id, streaming yes/no. All of it is metered and shown in Logs/Activity.
- **Prompt content in transit.** The router process runs inside the cluster space, in TEE memory, and
  forwards bodies to LiteLLM. It is designed to be a pass-through: prompt/completion content is never
  written to the database, logs, metrics or error reports. This property is part of the canonical
  snapshot the user pins (router image digest + config), i.e. it is verifiable, not promised. Enforced in
  code by: streaming passthrough without buffering beyond token counting; a log sanitiser that drops
  `messages`, `prompt`, `input`, `choices`, `delta`; and a unit test that fails if a `Generation` column
  can hold content.
- Its own published evidence (fetched bundle) — a fact about the platform, stored as `EvidenceSnapshot`.

## What the router cannot see (by construction)

- **Whether a gatekeeper exists**, how many, where, or what they concluded. There is no registration
  endpoint, no verdict header, no callback, no "verified" flag in any table. The gatekeeper only ever
  sends the user's original HTTP request upstream (ADR-003 §6).
- Verification results of anyone, including itself: it decodes but never verifies its own bundle
  (ADR-002).
- TLS private keys — terminated by the platform ingress inside the TEE; the router pod holds none.
- The platform's signing key — evidence is produced by the platform, the router cannot forge it.

## Why verdicts never reach the router

1. **Incentive separation.** The party that meters and bills must not be the party that reports
   trustworthiness; otherwise "verified ✓" is a marketing claim by the seller. The proof is produced on
   the user's hardware from primary evidence.
2. **No oracle.** If the router learned verdicts it could adapt behaviour to verified vs. unverified
   clients (or leak the population of verifying users). Blindness removes the channel.
3. **Simplicity of the claim.** The router's statement is falsifiable: "here is the bundle the platform
   published for this hostname". Anything stronger would need the router to be trusted, which is what
   we are trying to avoid.

## Threats and mitigations

| # | Threat | Mitigation | Residual |
| --- | --- | --- | --- |
| T1 | Operator swaps the model/router image after the user pinned | New canonical snapshot ⇒ new `evidenceDigest` ⇒ gatekeeper default policy denies; fail-closed blocks traffic | user must re-review and re-pin; rollout needs both digests pinned |
| T2 | MITM / DNS hijack of the router hostname | Channel binding: observed TLS leaf fingerprint must equal JWS `certFingerprint`; attacker cannot obtain the TEE-held key | none if roots are correct |
| T3 | Replay of an old bundle for a since-changed deployment | `issuedAt` freshness (`maxBundleAge`, default 24 h) + cert rotation invalidates old `certFingerprint` | window ≤ maxBundleAge for a deployment whose cert did not rotate |
| T4 | Rogue/compromised platform PKI root | Only user-listed roots are trusted; roots are named and fingerprinted; rotation = user action | trust in the platform root is an explicit assumption (see roots 1–2) |
| T5 | Router compromise (bug, malicious operator code) | Router holds no signing key ⇒ cannot mint evidence; compromise changes the image ⇒ digest changes; prompt content is not stored ⇒ no data at rest | in-memory access to live prompts while the compromised image runs — detectable only if the user re-checks the digest |
| T6 | Unattested model backend | Backends live in the same snapshot as the router; pinning covers their images and config (ADR-002 §4) | a backend outside the cluster space is out of scope and must not be configured |
| T7 | Gatekeeper misconfiguration (empty pins, wrong root) | Schema validation (`minItems`), fail-closed default, `policy test` offline, TUI shows stage of failure | fail-open is a documented foot-gun |
| T8 | Gatekeeper fed a poisoned policy that always allows | Default pin policy is built in and ANDed; user policies can only narrow | none |
| T9 | API key theft | Keys stored hashed (SHA-256) with a displayable prefix; per-key model scope, spend limit, expiry; revoke | client-side secret hygiene |
| T10 | Prompt leakage via logs/metrics/errors | Log sanitiser; content-free `Generation`; error bodies never echo input | LiteLLM/model server logging is the operator's config and is inside the pinned snapshot |
| T11 | Billing manipulation | Ledger append-only with idempotency keys; Stripe webhook signature; prices frozen per generation | — |
| T12 | Evidence poller as SSRF vector | `evidenceUrl` override is config-only (operator), never user input | — |

## Out of scope for v1

Client-side validation of `rootCaTeeQuote` (hook reserved), GPU attestation verification, model
weight integrity beyond image digests, side channels inside the TEE, DoS.
