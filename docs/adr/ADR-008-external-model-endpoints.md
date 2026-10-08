# ADR-008 — External model endpoints: a router-attested egress

- **Status:** Accepted
- **Date:** 2026-10-06
- **Decided by:** Denis (decisions 1–5 and the attestation semantics, SUP-221, 2026-10-06); CTO
  (reuse shape, data path, schema, runner — this document)
- **Review of record:** the six rulings on §10's open points, delegated by Denis to the CTO and posted
  on SUP-221 (2026-10-06). They are restated inline in §10 below; nothing in this document is proposed
  any more.
- **Amended:** 2026-10-08 by Denis's design change on SUP-252 — **external-endpoint trust is
  two-factor**: the cloud by its launch measurement (the admin list, as built) **and** the specific
  deployment by the evidence digest an admin pins per endpoint. This supersedes decision 1's "no
  per-endpoint digest approval" and §10 ruling 1, rewrites §3, and closes threat T13 (§9). The
  sections below are edited in place; [Amendment (SUP-252)](#amendment-sup-252--two-factor-endpoint-trust)
  states what changed and why.

## Context

Every model the router serves today lives inside its own cluster space: LiteLLM and the model servers
are part of the same canonical snapshot the user pins, and the threat model forbids anything else —
*"a backend outside the cluster space is out of scope and must not be configured"*
(`docs/threat-model.md:86`, T6 residual). The product now needs the opposite: **dynamically registered
external model endpoints** — models running in other deployments or other Swarm clouds — added by an
admin at runtime, attested **by the router itself** before any request is proxied.

Decisions already made (Denis, 2026-10-06), restated as the fixed points this design codes against:

1. **Trust = an admin-managed list of trusted measurements**, editable at any time in the console.
   ~~No per-endpoint digest approval; an endpoint is trusted iff its evidence verifies and its
   measurement is on the list.~~ **Superseded by SUP-252 (2026-10-08):** an endpoint is trusted iff its
   evidence verifies, its measurement is on the list, **and** the evidence digest it publishes equals
   the one an admin pinned for it (§3).
2. **Control plane = the router's own console**, a new admin section behind the existing
   `auth.adminEmails` / `AdminGuard` (`apps/router-api/src/app/auth/admin.guard.ts:18-32`).
3. **The registration token is the upstream's ordinary LLM API key** — the credential the router uses
   when proxying; stored as a secret, never rendered back.
4. **Admin sets per-token prices at registration** — feeds the ledger and the public model table like
   any built-in model.
5. **Fail-closed**: a failed re-attestation immediately drops the model from `/v1/models` and refuses
   in-flight routing, with status + event visible in the admin section.

## Amendment (SUP-252) — two-factor endpoint trust

Cloud-granularity trust (§10 ruling 1 as first written) admitted *every* deployment on a listed cloud:
the measurement is the cloud's root CA image, so any workload anyone deployed on that cloud satisfied
it (T13). Denis's design change makes trust two-factor, both required:

1. **The cloud**, by launch measurement — checked against the admin-managed trusted-measurements list,
   exactly as built (SUP-222).
2. **The specific application**, by its **evidence digest** — pinned per endpoint by the admin
   (`external_endpoints.pinnedEvidenceDigest`, `pinExternalEndpointDigest`).

`VERIFIED_BY_THIS_ROUTER` now means: measurement ∈ list **AND** evidence digest == the endpoint's
pinned digest. What changes, by layer:

- **Core.** A third per-endpoint trust mode, `trust: measurement-and-digest`
  (`apps/gatekeeper/pkg/config`, `pkg/policy/default.rego`): the `cloud-measurement` clause *and* the
  `evidence-digest` clause in one. Unlike the other two modes it runs with neither factor configured —
  the first verification is how the console learns what to approve — and a built-in denial carries a
  `refusal` code naming the factor: `digest-not-pinned` (nothing approved yet), `measurement-not-trusted`,
  `digest-mismatch` (a redeploy nobody approved). The first that applies is reported; the reason text
  names every missing factor.
- **Router.** Every external endpoint renders as `measurement-and-digest` with its pin as
  `trustedEvidence` (an empty list when none). `digest-not-pinned` projects to `PENDING` — the sidecar
  looked and is waiting for the admin, which is not a denial — and the other two to
  `DENIED_BY_THIS_ROUTER`, with the code as `lastStage`. `DIGEST_CHANGED` is therefore **gating**: at
  re-attest a mismatch denies, drops the models and closes in-flight connections (decision 5), and the
  timeline records both. `DIGEST_PINNED` records each approval with the digest approved. Re-pointing an
  endpoint's base URL withdraws its pin (the new upstream has not been looked at); restarts do not (the
  pin is trust, not a verdict — §8 is unchanged for every verdict column).
- **Evidence before approval.** The evidence poller now files an upstream's bundle whenever the last
  report's cryptography held — admitted *or* refused only by a trust factor — binding it to the TLS leaf
  the sidecar observed on that report (`observedCertFingerprint`) rather than to the egress pin, which
  only exists after admission. That is what lets the console show what a digest stands for *before*
  the admin pins it, and diff the approved deployment against a redeploy.
- **Console.** The TOFU-with-approval loop, one click per factor: the dossier shows *Measurement seen*
  (registry-signed badge, "Add to trust list") and *Digest seen* ("Pin this digest"); both approved →
  the sidecar re-attests at once → verified. A later check that sees a new digest shows old vs new with
  the evidence-summary diff (workloads, images) and "Approve new digest". The register dialog offers the
  same two approvals in the stage that waits for them.
- **Transparency** (ruling 3) now includes each endpoint's pinned digest and the evidence behind it,
  read-only for any signed-in user.
- **SUP-251** (in flight beside this) keeps its trust-list form guards. The "operator pasted an evidence
  digest into the measurements list" confusion is resolved structurally: the digest has its own home on
  the endpoint, and the measurements form still validates shape and says what it wants.

## 1. What this does to ADR-002's one rule — and what it does not

ADR-002's rule is that the router never learns a verdict **about itself**. That rule is untouched: the
router still decodes but never verifies its own bundle, still stores no verdict about its own
endpoints, and nothing here adds one.

What changes is the other direction. Toward an external upstream the router occupies **exactly the
position the gatekeeper occupies toward the router**: it is a paying client that fetches the
upstream's evidence, verifies it, binds the channel, and refuses to send traffic without a valid
verdict. A verdict about *someone else*, held by the party about to hand them prompts, is the
gatekeeper trust model — not a violation of ADR-002. Two consequences are carved explicitly:

- `docs/contracts/data-model.md` invariant 2 ("no table stores a verification verdict") is narrowed
  to **this deployment's own endpoints**. External-endpoint verdicts are stored as status and
  history (§6) — and are **never trust**: on restart every external endpoint starts unverified and
  is re-attested before it serves (§8).
- The vocabulary rule (ADR-002, `docs/contracts/console-graphql.md:17-18`) stays absolute for the
  router's own endpoints (*published / fresh / stale*). External endpoints get a separate, equally
  strict vocabulary: *verified by this router / denied by this router* — always naming the verifying
  party, because here there is one.

The honest limit, stated up front because the threat model (§9) depends on it: **a user who pins the
router's `evidenceDigest` is not transitively verifying external upstreams.** The trust list is
database state, not part of the canonical snapshot. What the pin does cover is the egress verifier
itself — the sidecar image (§2) is a container in the router-api pod and therefore inside the digest.
What the user additionally gets is transparency (§7): external models are labelled, their endpoint's
evidence is relayed raw for in-browser verification (the SUP-190 panel), and `usage.endpoint` names
where a generation went.

## 2. Reuse shape: the gatekeeper core runs as a sidecar egress

**Decision: embed the existing Go gatekeeper as a second container in the router-api pod — an
"attested egress" — rather than porting the verification core to TypeScript.** The preliminary lean
held up against the code; the evidence:

- **The TS port is three large subsystems, not one.** `libs/attestation` covers pipeline stages 1–6
  and is conformance-tested against the Go verifier (`libs/attestation-fixtures/vectors/`), but the
  spec'd semantics — "verify the TEE report" — is the attested-root path: AMD/Intel hardware report
  verification (`apps/gatekeeper/pkg/attestation/attestedroot/`, 1,773 LOC on `go-sev-guest` /
  `go-tdx-guest`), the OVMF launch-measurement rebuild (`internal/snpmeasure`, 734 LOC), and the
  Rego engine (`pkg/policy`, 721 LOC, embedded OPA). None has a TS equivalent, and the TS source
  says so itself (`libs/attestation/src/root-tee-evidence.ts:26-46`).
- **Node cannot even observe the channel the way the pipeline requires.** The TS verifier takes
  `observedTlsFingerprint` as a parameter (`libs/attestation/src/verify.ts:101`); the Go fetcher
  observes the leaf on the very dial that carries the bundle and fails on more than one peer cert
  per exchange (`pkg/attestation/fetch.go:131-146,239-250`).
- **The data plane we need already exists and is tested.** Pinned-cert upstream pools that verify
  against the pinned leaf only — never a CA bundle (`pkg/proxy/upstream.go:161-219`), fail-closed
  503 with an OpenAI-shaped body (`pkg/proxy/handler.go:84-111`), in-flight connections dropped on
  a verdict flip (`pkg/proxy/endpoint.go:356-369`), SSE flushed per write
  (`pkg/proxy/handler.go:140-146`), per-endpoint re-attest loops, metrics, audit, headless mode,
  SIGHUP reload that force-re-attests survivors (`pkg/proxy/supervisor.go:219-288`).
- **Zero verification-logic divergence**, which is the property Denis's spec names: the user-side
  gatekeeper and the router's egress run the same binary; the shared conformance fixtures already
  police the one place divergence could hide.
- **Packaging allows it.** The marketplace render path is plain `helm template` with no kind
  allow-list and no container-count constraint (swarm-cloud
  `apps/swarm-marketplace-api/src/app/deployments/chart-renderer.ts:61-153`); the one fail-closed
  gate is the component image list (`swarm-marketplace-spec` README §images), so the sidecar image
  is pinned by digest in `app.yaml` like every other image — which is precisely what makes the
  egress verifier part of what users pin. The sidecar needs no kube-apiserver access (the known
  cluster-space confinement), runs non-root on a read-only rootfs as a static `CGO_ENABLED=0`
  binary, and listens on loopback only.

**What the sidecar costs, stated:** a ghcr.io container image that does not exist yet (the TODO is
already filed at `.goreleaser.yaml:157-161`), ~30 MiB of binary, and one new core feature (§3). The
router's own deployment digest changes when the sidecar ships — an ordinary re-pin rollout (pin old
and new, deploy, remove old — ADR-003 §3).

**Rejected: LiteLLM `model_list` pointing at sidecar listeners.** LiteLLM's config is a
ConfigMap-rendered file with pod restart on change; it would put the upstream API keys into a second
process and a second chart; and everything the data path must preserve — metering, rate limits,
streaming, response shaping — lives in router-api *above* LiteLLM anyway (§4). LiteLLM adds a hop
and buys nothing here.

## 3. Attestation semantics, mapped onto the core

The verdict for an external endpoint is Denis's spec run on the existing pipeline — two-factor since
SUP-252 (see the amendment above): the measurement admits the cloud, the pinned digest the deployment.

```
fetch bundle (observed dial) ─▶ chain ─▶ root anchor ─▶ JWS ─▶ freshness ─▶ channel binding ─▶ policy
                                          │                                  (observed TLS leaf
                                          └ attested root: hardware report    == payload.certFingerprint,
                                            verified to the CPU vendor,       then THAT leaf is pinned
                                            reportData ↔ key binding,         for all egress traffic)
                                            measurement rebuilt from
                                            published artefacts
                                            → measurement ∈ admin trust list
                                            → AND evidenceDigest == endpoint's pinned digest (SUP-252)
```

- **"The measurement" is the normalised VM launch measurement of the upstream cloud's root CA**
  (mrEnclave hex) — the value the attested-root check derives, never asserts
  (`pkg/attestation/attestedroot/`, ADR-003 §2a). This is the only measurement that exists for every
  Swarm deployment today (ADR-007 §3a records that no producer publishes deployment-level
  measurements), and it is what SUP-139 (draft PR #56) already teaches the core to pin:
  `attestedRoots.trustedMeasurements`, replacing exactly the registry-signature leg while the
  hardware report, key binding, measurement rebuild and `requireNetworkType` all still apply.
  **SUP-139 is a dependency of this design.**
- **The admin list is the sole authority.** Under SUP-139's user-side semantics a registry-signed
  measurement is admitted without a pin. For the router egress that would make the list decorative —
  every genuine Swarm cloud is registry-signed — so the sidecar's policy requires
  `rootAttestation.measurement ∈ admin list` regardless of `measurementSource`. The registry result
  is still reported (it is useful display state), it just does not admit on its own.
- **The core gained per-endpoint trust modes.** The built-in default policy requires a per-endpoint
  `trustedEvidence` digest pin (`pkg/policy/default.rego`). SUP-222 added `trust: cloud-measurement`
  — a verified attested root whose measurement is in the configured list, no digest — loudly documented
  as the weaker mode (*a measurement admits a cloud, never a deployment*). **SUP-252 replaced it for the
  egress** with `trust: measurement-and-digest`: both clauses at once, so the measurement admits the
  cloud and the endpoint's `trustedEvidence` pin admits the deployment. Neither factor has to be
  configured for the file to run; a denial names the missing factor (`refusal`:
  `digest-not-pinned` / `measurement-not-trusted` / `digest-mismatch`). `cloud-measurement` stays in the
  core for anyone who wants cloud-granularity trust deliberately; neither mode is ever the default for
  the user-facing CLI.
- **Re-attest TTL: `reattestInterval` default 10 min for the egress** (the core's default is 5 min;
  the admin-configurable value is bounded to [1 min, 1 h] — "hourly" is the acceptable upper bound).
  `maxBundleAge` stays 24 h, `verdictCacheTtl` stays 60 s.
- **Cert rotation never opens a window — by refusal, not by instant re-handshake.** A connection
  whose leaf does not match the pin is refused at the dial (`pkg/proxy/upstream.go:188-199`), the
  request answers 503, and a re-attestation is launched immediately on a detached context
  (`pkg/proxy/handler.go:195-208`). That re-check respects `verdictCacheTtl`, so after a rotation
  the endpoint may answer 503 for up to 60 s before the fresh verdict re-pins — fail-closed
  throughout, never a window of unpinned traffic. We accept this semantics as shipped.
- **A trust-list edit takes effect on the next check, not after the TTL** — the ADR-003 §7 pattern
  as actually implemented: reload rebuilds the verifier and discards every cached verdict, and
  `Supervisor.Reload` force-re-attests every surviving endpoint (`pkg/proxy/supervisor.go:277-283`).
  Since every admin mutation triggers a reload (§5), an edit is live within one reload + one
  re-attest, and a measurement *removed* from the list denies on that forced re-check — which drops
  the model and closes in-flight connections (decision 5). Pinning a digest is an admin mutation like
  any other, so an approval is live on the next check too — the "re-attest (immediate)" the console's
  approval loop relies on.

## 4. Data path: a native egress leg through the sidecar, bypassing LiteLLM

Today every `/v1` request forwards to the single `backends.litellm.baseUrl`
(`apps/router-api/src/app/api/v1/litellm.client.ts:64-104`). Everything the issue requires preserved
sits in router-api above that seam: admission and four-bucket rate limits
(`gateway-policy.service.ts`, `rate-limit.service.ts`), generation recording with the no-content
invariant (`generation-recorder.service.ts`, enforced by `db/entities/invariants.spec.ts`), SSE relay
without buffering beyond one event (`stream-relay.ts:28-32`), response shaping and the `usage`
extension fields (`response-shaping.ts:74-93`).

So the external leg changes only the forward target:

- The upstream client grows a seam: per-model resolution to either the LiteLLM backend (unchanged)
  or an **external leg** — base URL `http://127.0.0.1:<port>` of the sidecar's per-endpoint loopback
  listener, `model` rewritten to the registered upstream model name, and `Authorization: Bearer
  <upstream API key>` injected **by router-api**. The sidecar passes `Authorization` through
  untouched and holds no secret, exactly as ADR-003 §8 specifies — the key never appears in the
  sidecar's config file.
- The sidecar dials the upstream over TLS verified **against the pinned leaf only**, streams SSE
  with per-write flushes, and answers fail-closed 503 with the OpenAI-shaped `gatekeeper_error`
  body when the verdict is missing or negative. Router-api maps that to its own refusal: **503
  `attestation_failed`** on the `/v1` surface — which amends the error-table note in
  `docs/contracts/router-api.md` ("emitted by the gatekeeper, never by the router": for external
  models the router *is* a gatekeeper, and says so).
- Listener ports are allocated deterministically per external endpoint and recorded on its row;
  loopback is shared across containers in one pod, so no Service, no cluster traffic, no exposure.
- Requirement on registrable upstreams, stated as product scope: an OpenAI-compatible `/v1` surface
  on a hostname whose platform publishes `/.well-known/swarm-evidence` — i.e. a Swarm-deployed
  model service, typically another Confidential Router or a bare vLLM behind a locked space.

Metering is unchanged in kind: external models carry admin-set prices on their catalogue row, prices
are frozen per generation, the debit path is identical. `usage.endpoint` carries the external
endpoint's name; `usage.evidence_digest` carries the upstream digest observed by the verdict that
admitted the request — coverage here is stronger than for built-ins (a verdict, not merely a fresh
publication), and the field keeps its shape.

## 5. Control loop: render config, signal reload, read status back

Router-api drives the sidecar the way an operator drives a headless gatekeeper — through its config
file — because the admin socket is read-only *by design* (`pkg/proxy/admin.go:141-145`) and we keep
that property:

1. **Render.** On boot and on every admin mutation, router-api renders the sidecar config from DB
   state into a shared `emptyDir` volume: one `endpoints[]` entry per enabled external endpoint
   (listen port, upstream URL, `trust: cloud-measurement`, `failMode: closed`), the
   `attestedRoots.trustedMeasurements` list from `trusted_measurements`, `reattestInterval` from
   admin config, `admin.listen` on a loopback TCP port. No secrets in the file (§4).
2. **Reload.** The sidecar image's entrypoint watches the rendered file and sends the process
   SIGHUP on change — confined to the sidecar container, no `shareProcessNamespace`, no core
   change. A reload that fails to load changes nothing and logs why (`pkg/cli/cmd_run.go`);
   unchanged endpoints keep their connections (`pkg/proxy/endpoint.go:156-158`).

   Two refinements the e2e stand forced (SUP-229), both about the difference between a file a *person*
   wrote and a file a control loop renders:

   - **The entrypoint waits for a configuration the gatekeeper will run**, not merely for one it can
     read. The first render on a deployment with no external endpoint registered is a valid document
     with an empty `endpoints` list, which `gatekeeper run` refuses — correctly, for a person. Starting
     the gatekeeper on it would have the container exit at once and crash-loop over a deployment that
     has done nothing wrong, so `pkg/sidecar` keeps waiting and logs why.
   - **A reload is validated as *editable*, not as runnable.** The completeness rules — at least one
     endpoint, and a non-empty measurement list for a `trust: cloud-measurement` endpoint — say the
     opposite of what they mean at reload time: a configuration that admits nothing is exactly what an
     admin withdrawing their last trusted cloud asked for. Refusing it would keep the previous
     configuration running, and with it the listeners and the verdicts that admitted the traffic being
     revoked — a fail-open produced by caution. Malformed values are still refused; those are not an
     instruction.
3. **Read back.** Router-api polls the admin socket — `/verdicts` and `/status` return the full
   per-endpoint `status.Report` including stage, reason, measurement, `measurementSource`, observed
   digest and pinned fingerprint (`pkg/status/status.go:162-218`) — and projects it into endpoint
   status, the event timeline, and catalogue membership (§6, §8). Polling interval ~5 s; the admin
   client is deliberately poll-only (`pkg/proxy/client.go:82-89`).

Chart changes (swarm-marketplace-catalog): second container in the `confidential-router-api`
Deployment, its digest added to the component image list, the shared `emptyDir`, and the upstream
key env/secret plumbing — following the existing Secret-not-ConfigMap rule, since the rendered
ConfigMap is readable inside the published evidence (SUP-124 precedent,
`charts/confidential-router-api/templates/secret.yaml:49-60`).

## 6. Schema

New tables (TypeORM migrations, portable column presets as in `src/app/db/columns.ts`):

| Entity | Purpose |
| --- | --- |
| `ExternalEndpoint` | `id`, `name` (unique, its own namespace — **not** `endpoints`, which stays the router's own hostnames), `baseUrl`, `hostname` (derived), `listenPort`, `enabled`, `status: pending\|verified\|denied\|disabled`, `lastCheckedAt`, `lastStage?`, `lastReason?`, `measurementSeen?`, `measurementSource?`, `evidenceDigestSeen?`, `pinnedCertFingerprint?`, `apiKeyCiphertext` + `apiKeyPrefix` (display only), `createdByUserId`, timestamps |
| `TrustedMeasurement` | `measurement` (normalised mrEnclave hex, unique), `note`, `addedByUserId`, `addedAt` |
| `ExternalEndpointEvent` | append-only timeline: `externalEndpointId`, `at`, `kind: registered\|verified\|denied\|digest_changed\|measurement_changed\|disabled\|key_rotated`, `stage?`, `reason?`, `measurement?`, `evidenceDigest?` — what the admin section renders; bounded retention like evidence blobs |

Amendments to existing tables, chosen to keep every downstream query unchanged:

- **`models` gains `origin: config|external` and a nullable `externalEndpointId`** (XOR with
  `endpointId`). One catalogue table keeps `/v1/models`, key scopes, metering, Activity and Logs
  working without a union. Data-model invariant 4 is narrowed: config-origin rows remain
  boot-projected and API-immutable; external-origin rows are admin-managed at runtime and never
  touched by `CatalogService.project()` / `retire()`.
- **`generations` and `evidence_snapshots` gain a nullable `externalEndpointId`.** The evidence
  poller stores external upstream bundles under the same idempotent unique key, which is what feeds
  the raw-bundle relay for the console's in-browser verification (§7).
- **Invariant 2 narrowed** as stated in §1; `ExternalEndpoint.status` and the event table are the
  documented exception, with the rule that they are display/admission state re-derived from live
  verification — never inputs to it.

**The upstream API key** is stored encrypted (AES-256-GCM) under a key supplied via Secret+env
(`CR_API_SECRETS_KEY`), not hashed — it must be usable for proxying, unlike `api_keys.keyHash`. The
TEE's LUKS disk already encrypts at rest; the application-level envelope keeps the plaintext out of
SQL, dumps and Postgres memory, and the API never returns it (write-only field; `apiKeyPrefix` for
display; rotation is a new write). This is the repo's first reversible secret at rest and the
pattern should be written once, in one module.

Catalogue runtime behaviour: external models live in a second in-memory map beside the config
catalogue, refreshed on admin mutation and on status flips from the sidecar poll — the
`catalog.service.ts:49-51` assumption ("config cannot change underneath a running process") stays
true for config models and is explicitly not extended to external ones. A model is listed in
`/v1/models` and resolvable by the gateway **iff its endpoint status is `verified`** — the
fail-closed drop of decision 5, enforced at admission as well as at the egress.

## 7. Console and API surface

- **Admin section** (new `(console)/admin` route group; nav entry gated by a new `me { isAdmin }`
  field — today nothing in the browser can know, `viewer.model.ts:36-52`): external endpoints CRUD
  (register with name, base URL, API key write-only, models + prices; enable/disable; rotate key),
  per-endpoint status chip + verdict timeline from `ExternalEndpointEvent`, and the trusted
  measurements CRUD with the cloud-granularity warning spelled out. All resolvers
  `@UseGuards(SessionGuard, AdminGuard)` method-level, one input object per mutation, registered in
  `CONSOLE_RESOLVERS` with SDL regen — the established conventions.
- **Models page and chat model picker**: external models appear with an "External" origin and their
  attestation state in the external vocabulary (§1). The picker only offers externals whose
  endpoint is `verified` — the API decides, as it already does for chat capability.
- **SUP-190's inspect panel renders an external endpoint's evidence the same way.** The raw-bundle
  relay `GET /v1/evidence/:endpoint` extends to external endpoint names (serving the poller's
  stored upstream bundle, byte-for-byte), and the panel runs the browser's own tier-1 verification
  on it — so a user can check an external upstream's evidence and deployment graph themselves,
  which is the per-user mitigation for trust the router pin does not cover (§1).
- **Transparency (proposed, open point 3; ruled yes):** the external endpoint list with status,
  measurement and digest — each endpoint's pinned digest since SUP-252 — and the trust list itself —
  exposed read-only to any signed-in user, not only admins. An operator curating external capacity in secret is the configuration this product
  should make impossible to sell as confidential.

## 8. Re-attest runner, restarts

The sidecar's per-endpoint attest loop **is** the runner — single-replica router-api
(`replicaCount: 1` in the chart) drives it in-process via config, and nothing about the design
assumes more replicas than the chart ships. Across restarts: router-api renders config from DB at
boot; the sidecar starts every endpoint with no verdict and force-attests immediately
(`pkg/proxy/endpoint.go:251-265`); router-api holds every external endpoint at `pending` — out of
`/v1/models`, refusing routing — until the first `verified` report arrives on the status poll.
Verdicts are re-derived, never persisted as trust; the event table is history, not input.

## 9. Threat model delta

T6's residual is deliberately reversed for external endpoints, and these are new:

| # | Threat | Mitigation | Residual |
| --- | --- | --- | --- |
| T13 | Malicious or compromised deployment on a *trusted cloud* registers as an upstream (measurement admits a cloud, never a deployment) | **Closed by SUP-252.** Admission is two-factor: the endpoint's evidence digest must equal the one an admin pinned for it, so a trusted cloud no longer admits every deployment on it. A redeploy fails closed at `digest-mismatch` until the new digest is approved; the dossier shows the evidence-summary diff the approval is made from | The admin approving a digest is trusted to read what it stands for — the same trust they hold for the measurement list (T16) |
| T14 | Prompt confidentiality now extends to the upstream: the router forwards content to another operator's TEE | Evidence verified + channel pinned before any byte; external models labelled everywhere; upstream evidence inspectable by users; upstream logging behaviour is inside *its* attested snapshot | Users do not pin upstream digests; they trust the admin's list |
| T15 | Upstream API key theft | Encrypted at rest under a Secret-fed key, write-only API, prefix display, rotation; egress only via loopback sidecar to the pinned upstream | Plaintext in router-api memory while proxying — same class as T5 |
| T16 | Admin abuse of the trust list (add a rogue cloud's measurement) | Every trust mutation is an event + WARN log naming the operator; proposed public read-only trust list (§7) | An admin is trusted today for invites; this raises the stakes — open point 3 |
| T17 | Evidence replay / stale upstream bundle | Same bounds as the user-side gatekeeper: `maxBundleAge` 24 h, forced re-attest ≤ TTL, cert rotation re-binds via the platform's re-signed bundle | Window ≤ min(TTL, bundle age) as in T3 |

## 10. Open points, and how they were ruled

Denis delegated these to the CTO ("нет времени углубляться, если согласен — делай"); the rulings were
posted on SUP-221 on 2026-10-06 and are the review of record for this document. None of them is open.

1. ~~**Cloud-granularity trust (T13): accepted for v1**~~ — **superseded on 2026-10-08 by SUP-252
   (Denis): trust is two-factor**, the cloud by measurement *and* the deployment by an admin-pinned
   evidence digest; T13 is closed (§9). The UX obligation this ruling carried is kept and now gates a
   decision rather than informing one: the admin section renders the full evidence summary (workloads,
   image digests) for every registered endpoint at registration and on every change — and before an
   approval, so the admin pinning a digest has seen what it stands for, and a redeploy is approved from
   the old-vs-new diff. `declaredImages`-style narrowing is no longer needed for T13.
2. **Registry-signed measurements not on the admin list: rejected.** The list is the sole authority; a
   registry signature renders as an advisory badge and admits nothing. Carried into the core by
   SUP-222's list-is-sole-authority knob, and the denial names the misreading it pre-empts.
3. **Transparency: yes for signed-in users** — read-only external endpoints, trust list and verdict
   history, and (SUP-252) each endpoint's pinned evidence digest with the evidence behind it. The anonymous `models` surface lists external models like any other (name, price,
   availability) and exposes no endpoint URLs, no trust list and no verdict detail, so a prober learns
   nothing about topology.
4. **Settlement stays out of band.** The upstream key is the router operator's account with the model
   operator; inter-operator billing is out of scope.
5. **Mid-stream abort on a verdict flip, metered `aborted`** — with one addition: the terminal SSE or
   error frame must name the reason class (`attestation_revoked`) so a client sees policy rather than
   flakiness.
6. **TTL default 10 min, bounds [1 min, 1 h].**

## Consequences

- **Dependency:** SUP-139 (`trustedMeasurements`, draft PR #56) lands first; this design builds on
  its semantics and store.
- Implementation issues to cut after review, staged: (1) gatekeeper core — `cloud-measurement`
  endpoint trust mode + list-is-sole-authority knob + sidecar container image; (2) router-api —
  schema/migrations, secret envelope, config renderer + status sync; (3) router-api — external
  egress leg in the gateway, catalogue membership, error mapping; (4) GraphQL admin API +
  `isAdmin`; (5) console admin section; (6) Models/picker/inspect external states + evidence relay
  extension; (7) chart + `app.yaml` (sidecar image pin, Secret plumbing); (8) docs/contract
  amendments (`data-model.md` invariants 2/4, `router-api.md` error note, `console-graphql.md`
  vocabulary + screen table, threat model §9) and an e2e stand: mock external upstream =
  `tools/mock-evidence-host` + `tools/mock-litellm` behind one hostname, with a rotate-measurement
  beat for the fail-closed demo.
- The stand (8, SUP-229) runs the shipped `gatekeeper-sidecar` over
  `apps/gatekeeper/cmd/gatekeeper-teststand`: the real gatekeeper with its attested-root *hardware* leg
  read from a file, behind a build tag no release compiles. A SEV-SNP report is signed by AMD and its
  `reportData` commits to the issuing CA's public key, so there is no mock that can mint one and no
  stand that can issue leaves from the one real fixture this repository holds. Every other leg — the
  rendered config, the evidence fetch, JWS and chain verification, the channel binding, the Rego set,
  the trust store, forced re-attestation, the fail-closed drop of in-flight connections — is the
  production path, and the substitution names itself in the verdict's own logs.
- The sidecar changes the router's canonical snapshot: shipping this is a re-pin rollout for every
  pinned user, announced as such.
- `swarm-chrome-extension` and the user-side gatekeeper are unaffected; a future "verify the whole
  chain" story (user attests router *and* its externals) stays open and is not promised here.
