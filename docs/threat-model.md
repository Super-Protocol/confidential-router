# Threat model

Scope: Confidential Router (router-api, router-ui, LiteLLM + model servers in one Swarm Cloud cluster
space), the user-side Gatekeeper, and — since ADR-008 — the router's **attesting egress** toward model
endpoints registered at runtime in other deployments. Companion to ADR-002, ADR-003 and ADR-008.

How the pieces this reasons about are configured and run:
[`gatekeeper.md`](gatekeeper.md) (trusted roots, pins, policies, denials),
[`router.md`](router.md) (models, endpoints, evidence retrieval, billing), and
[`quickstart.md`](quickstart.md), which walks T1 — a redeployment behind a pinned
digest — from a clean clone in ten minutes.

## Assets

| Asset | Owner | Protection goal |
| --- | --- | --- |
| Prompt and completion content | user | confidentiality from the operator and the platform staff |
| Which deployment served a request (images, config) | user | integrity / verifiability |
| API keys, session cookies | user | secrecy |
| Credit balance, metering counters | user & operator | integrity |
| Platform PKI root key, TLS private keys | platform | secrecy — never leave the TEE |
| The upstream API key of a registered external endpoint | router operator | secrecy — usable for proxying, never readable back (ADR-008, T15) |

## Trust boundaries

```
┌─ user's machine ───────────────┐      ┌─ Swarm Cloud cluster space (TEE nodes) ────────────────────┐
│ app ──▶ gatekeeper (verifier)  │ TLS  │ ingress (TLS terminates in TEE) ─▶ router-api ─▶ LiteLLM ─▶ model │
│         trusted roots, pins    │─────▶│ /.well-known/swarm-evidence  (published by the platform)     │
└────────────────────────────────┘      └─────────────────────────────────────────────────────────────┘
                                                   ▲ evidence signed by platform PKI (TEE-attested root)
```

Since ADR-008 there is a second boundary, with the router on the verifying side of it:

```
┌─ this cluster space ─────────────────────────┐      ┌─ another deployment, another cloud ──────┐
│ router-api ──▶ egress sidecar (verifier) ────│ TLS  │ ingress ─▶ an OpenAI-compatible model    │
│                admin trust list, pinned leaf │─────▶│ /.well-known/swarm-evidence              │
└──────────────────────────────────────────────┘      └──────────────────────────────────────────┘
```

It is crossed only by traffic for a model an admin registered, and only while this router holds a live
verdict about the deployment on the other side of it.

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
- Verification results **about itself**: it decodes but never verifies its own bundle (ADR-002), and no
  table holds a verdict about one of its own endpoints. Since ADR-008 it does hold verdicts about
  *other* deployments — the external endpoints an admin registered, which it is the paying client of.
  That is the gatekeeper's own position, in the other direction, and it changes nothing here: a verdict
  about someone else is no oracle about this deployment's own verification.
- TLS private keys — terminated by the platform ingress inside the TEE; the router pod holds none.
- The platform's signing key — evidence is produced by the platform, the router cannot forge it.

## Why verdicts about this deployment never reach the router

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
| T6 | Unattested model backend | Backends live in the same snapshot as the router; pinning covers their images and config (ADR-002 §4) | **Deliberately reversed for external endpoints (ADR-008 §9).** A backend outside the cluster space used to be out of scope and forbidden; an admin may now register one, and what stands in for the user's pin is that *the router itself* attests it before proxying — verified evidence, a measurement on the admin's list, a pinned certificate, fail-closed re-attestation. The user's own pin does **not** reach it; that residual is T14. For a backend nobody registered, the original rule stands |
| T7 | Gatekeeper misconfiguration (empty pins, wrong root) | Schema validation (`minItems`), fail-closed default, `policy test` offline, TUI shows stage of failure | fail-open is a documented foot-gun |
| T8 | Gatekeeper fed a poisoned policy that always allows | Default pin policy is built in and ANDed; user policies can only narrow | none |
| T9 | API key theft | Keys stored hashed (SHA-256) with a displayable prefix; per-key model scope, spend limit, expiry; revoke | client-side secret hygiene |
| T10 | Prompt leakage via logs/metrics/errors | Log sanitiser; content-free `Generation`; error bodies never echo input | LiteLLM/model server logging is the operator's config and is inside the pinned snapshot |
| T11 | Billing manipulation | Ledger append-only with idempotency keys; Stripe webhook signature; prices frozen per generation | — |
| T12 | Evidence poller as SSRF vector | `evidenceUrl` override is config-only (operator), never user input | — |

### The attesting egress (ADR-008 §9)

Toward an external upstream the router occupies exactly the position the gatekeeper occupies toward the
router: a paying client that fetches the upstream's evidence, verifies it, binds the channel, and refuses
to send traffic without a valid verdict. These are the threats that creates, as ADR-008 §9 tables them —
that table and the SUP-221 rulings are the review of record.

| # | Threat | Mitigation | Residual |
| --- | --- | --- | --- |
| T13 | Malicious or compromised deployment on a *trusted cloud* registers as an upstream (a measurement admits a cloud, never a deployment) | Registration is admin-only and names one base URL; the observed digest and images are displayed at registration and on every change (events); endpoint-level narrowing (`declaredImages`-style) is a designed-for follow-up | **Real.** Cloud-granularity trust is decision 1's trade, accepted for v1 (SUP-221 ruling 1) |
| T14 | Prompt confidentiality now extends to the upstream: the router forwards content to another operator's TEE | Evidence verified and channel pinned before any byte; external models labelled everywhere; the upstream's evidence relayed for the user's own in-browser verification; upstream logging behaviour is inside *its* attested snapshot | Users do not pin upstream digests; they trust the admin's list |
| T15 | Upstream API key theft | Encrypted at rest (AES-256-GCM) under a Secret-fed key, write-only API, prefix display, rotation; egress only through the loopback sidecar to the pinned upstream | Plaintext in router-api memory while proxying — the same class as T5 |
| T16 | Admin abuse of the trust list (adds a rogue cloud's measurement) | Every trust mutation is an event and a WARN log naming the operator; the external-endpoint list and the trust list are read-only to any signed-in user (SUP-221 ruling 3) | An admin is already trusted for invitations; this raises the stakes |
| T17 | Evidence replay / stale upstream bundle | The same bounds as the user-side gatekeeper: `maxBundleAge` 24 h, forced re-attest ≤ TTL, and a certificate rotation re-binds through the platform's re-signed bundle | Window ≤ min(TTL, bundle age), as in T3 |

## How these are exercised

T1, T2, T4, T7 and the egress threats are not left as prose. `tools/mock-evidence-host` can rotate the
deployment, rotate the certificate without re-signing the binding, or re-chain to a root the user never
trusted, on demand, and `tools/demo`'s external stand can move an upstream cloud's launch measurement or
withdraw its hardware report; the suites hold each of them to the stage that must refuse it:

| Threat | Made to happen by | Asserted in |
| --- | --- | --- |
| T1 redeploy behind a pin | `rotateDeployment()` | `tools/demo/src/story.ts` (503, `stage: policy`), `tools/mock-evidence-host/src/server.spec.ts` |
| T2 channel binding broken | `breakChannelBinding()` | `tools/mock-evidence-host/src/server.spec.ts` (`stage: tls-fingerprint`) |
| T3 stale bundle | `issuedAtSkewMs` | `tools/mock-evidence-host/src/server.spec.ts` (`stage: jws`) |
| T4 wrong root | `useOtherCloud()` | `tools/mock-evidence-host/src/server.spec.ts` (`stage: untrusted-root`) |
| T7 empty pins | a fresh `gatekeeper init` | `apps/gatekeeper/pkg/cli` (`config validate`, "never admits") |
| T10 prompt leakage | — | `apps/router-api` (`Generation` column test, log sanitiser) |
| T13 a cloud, not a deployment | an upstream whose registry-signed measurement the admin never listed | `apps/router-api-e2e/src/external-endpoints.e2e.spec.ts` (`stage: policy`, "the list is the sole authority"), `apps/gatekeeper/pkg/verifier` |
| T13 a trusted cloud redeploys | `sidecar.rotateMeasurement()` | `apps/router-api-e2e/src/external-endpoints.e2e.spec.ts`, `tools/demo/src/story.ts` (step 12 — the model leaves `/v1/models`) |
| T16 trust withdrawn live | `removeTrustedMeasurement` | `apps/router-api-e2e/src/external-endpoints.e2e.spec.ts` (denied on the next forced check; an in-flight stream ends `attestation_revoked`) |
| T15 key never read back | registration + the egress leg | `apps/router-api/src/app/secrets`, `apps/router-api-e2e/src/external-endpoints.e2e.spec.ts` (only the upstream ever sees the bearer) |
| T17 / the anchor below the list | `sidecar.denyAttestation()` | `apps/router-api-e2e/src/external-endpoints.e2e.spec.ts` (`stage: untrusted-root` — with no attested root there is no measurement, and the admin's list cannot rescue it) |
| T14 the user checks the other end | a registered upstream, relayed through `GET /v1/evidence/{endpoint}` | `apps/router-ui-e2e/src/secure-origin.spec.ts` — a real browser runs its own tier 1 over the upstream's publication and draws its graph, on the only origin where `crypto.subtle` exists. T14's residual is that users do not pin upstream digests; this is what they get instead, so it is asserted rather than described |

## Out of scope for v1

Client-side validation of `rootCaTeeQuote` (hook reserved), GPU attestation verification, model
weight integrity beyond image digests, side channels inside the TEE, DoS.
