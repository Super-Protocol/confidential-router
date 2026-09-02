# ADR-003 — Trust model of the gatekeeper

- **Status:** Accepted
- **Date:** 2026-08-30 (amended 2026-09-02, SUP-114: §2a, the second trust anchor)
- **Decided by:** Denis (decisions 2, 4, 6, 2a), CTO (Rego semantics, cache, re-attestation)

## Context

The gatekeeper is the only component that produces a verdict. It must be simple to configure correctly,
impossible to misconfigure into silently trusting the wrong thing, and expressive enough for users who
want more than a digest pin (e.g. "only these container images"). It ports the semantics of swarm-cloud's
desktop gatekeeper (`apps/swarm-gatekeeper-desktop/src/main/services/AttestationService.ts`) and the Rego
evidence gate of `apps/gatekeeper-proxy/src/evidence.ts`.

## Decision

### 1. Two-layer trust: crypto anchor, then policy

```
fetch bundle ─▶ cert chain leaf→root ─▶ root ∈ trustedRoots ─▶ JWS (RS256|ES256K) ─▶ freshness ─▶ channel binding ─▶ Rego
              (stage: fetch)   (cert-chain)   (untrusted-root)     (jws)           (jws)         (tls-fingerprint)  (policy)
                                        │
                                        └─ or: the root's own TEE evidence proves it is a Swarm root (§2a)
```

- Stages 1–6 are the verifier (`pkg/attestation`, byte-for-byte the algorithm of swarm-cloud
  `libs/swarm-attestation/src/verify.ts`, proven by the shared conformance fixtures). Any failure is a
  **deny** with the stage name; Rego is never evaluated on unverified evidence.
- Channel binding is always **observed**: the gatekeeper compares `payload.certFingerprint` with the
  SHA-256 of the DER leaf it saw on its own TLS handshake to the upstream. `tlsLeaf`
  (producer-asserted binding) is ignored — that mode exists for browsers without channel access.
- Stage 7 (Rego) is authorisation over the verified payload.

### 2. Trusted roots are global

`trustedRoots[]` (name + PEM, inline or `pemFile`) is a global list — the "Trusted Clouds" model of the
desktop gatekeeper. A root is matched by the SHA-256 fingerprint of its DER. Roots are not
per-endpoint: a root identifies a *cloud*, endpoints identify *deployments*. `rootCaTeeQuote` is parsed
and shown, not validated (same as swarm-cloud today; a `quoteVerifier` hook is reserved).

### 2a. Second anchor: roots that prove what they are

*(Added 2026-09-02, SUP-114. Decision: Denis — "a user should not have to `trust roots add` a Swarm cloud
by hand"; the browser extension already accepts the same root the same way.)*

`trustedRoots[]` answers "did the user say they trust this cloud?". It cannot answer "is this a Swarm cloud
at all?", and for a first-time user that gap is filled by pasting a certificate they have no way to check —
trust-on-first-use with extra steps. So a root may also be trusted **because its own TEE evidence proves it
is a Super Swarm root**.

A Super Swarm Root CA runs inside an SEV-SNP or TDX VM built by `Super-Protocol/sp-vm`, and its X.509
carries what that VM attested: the challenge type at OID `1.3.6.1.3.8888.1.1`, the network type at
`1.3.6.1.3.8888.4`, and the serialised `TeeEvidence` at `0.6.9.42.840.113741.1337.6`. The check
(`pkg/attestation/attestedroot`) is the one `tee-pki`'s `root-certificate-verifier` and the browser panel
run, in the same order:

1. **hardware report** — SEV-SNP via `go-sev-guest` (ARK/ASK/VCEK from the evidence, chained to AMD's
   built-in root, TCB binding checked), TDX via `go-tdx-guest`. Vendor CRLs are a separate, opt-in step:
   a CRL that cannot be fetched leaves revocation *unknown*, never *clean*;
2. **key binding** — `reportData[0:32]` must equal SHA-256 of the certificate's SubjectPublicKeyInfo.
   Without it a valid report from any Super Protocol VM would vouch for any certificate;
3. **measurement** — the VM's launch digest is rebuilt from published artefacts (`vm.json` of the sp-vm
   release, the OVMF image from the platform's object store, both content-addressed) and must reproduce the
   report's own `MEASUREMENT`; it is then recomputed for the canonical single-Milan-core configuration and
   wrapped into the 32-byte `mrEnclave` of `sp-vm/docs/04-vm-measurements.md`;
4. **registry** — that `mrEnclave` must carry a Super Protocol signature, verified against an RSA-3072 key
   **pinned in the binary** (the same `TRUSTED_PUBLIC_KEY_SPKI_B64` the platform's own clients pin). This is
   the step that closes the chain: without it the check would prove only that *some* SEV-SNP VM issued the
   certificate, which any tenant of any AMD host could arrange.

Rules:

- **The manual store wins.** The attested path only runs for a chain that has already validated and failed
  *only* on membership of `trustedRoots[]` — the same precondition that gates the dashboard's "add this
  root" affordance. Before that point `certChain` is an attacker-controlled array.
- **Fail closed.** A registry that cannot be reached, artefacts that cannot be fetched, an unsupported
  evidence type: all deny. Manual pins keep working offline, which is the escape hatch.
- **Nothing is judged that the operator did not ask to be judged.** `debugAllowed`, `ciphertextHiding`,
  `pageSwapDisabled`, the vMPL and the SNP firmware TCB are reported and exposed to Rego as
  `input.attestation.rootAttestation.teeFlags`; the gatekeeper enforces none of them. The live Swarm Cloud
  root declares network type `untrusted` — the platform's own network split, not a judgement about the CA —
  so `requireNetworkType` defaults to `any` and surfaces the declaration rather than rejecting it silently.
- Config: `attestedRoots: {enabled: true, registryBaseUrl, cacheTtl: 10m, requireNetworkType: any,
  checkRevocations: false}`. With it on, `trustedRoots[]` may be empty, so `gatekeeper trust roots add`
  becomes optional for a Swarm cloud rather than the first step of every setup.
- The verdict names the root `attested:<mrEnclave>` and `gatekeeper verify` prints the same panel the
  browser extension shows: report integrity, revocation, CPU generation, TCB, the flags, the measurement
  and whether it is in the registry, and the key binding.

### 3. Per-endpoint pinned `evidenceDigest` list

Each `endpoints[]` entry carries `trustedEvidence[]`: one or more `evidenceDigest` values the user
accepts for that upstream. Format: canonical `sha256/<base64url>` (43 chars, unpadded); `sha256:<hex>`
and bare 64-char hex are accepted and normalised at load time. `minItems: 1` — an endpoint without pins
is a configuration error. A list (not a single value) exists so a rollout can be pre-approved: pin the
old and the new digest, deploy, remove the old.

Pins are explicit. There is no trust-on-first-use; `gatekeeper endpoint discover <url>` prints what an
upstream currently publishes (digest, images, root) for the user to review and paste.

### 4. Generated trust module + default policy

At startup (and on config reload) the gatekeeper **generates** a Rego data document from config:

```rego
package gatekeeper.trust

roots := {"swarm-cloud-prod": {"fingerprint": "sha256/…"}}

endpoints := {
  "llama-33-70b": {
    "hostname": "llama-33-70b.tee.swarm.cloud",
    "evidence_digests": {"sha256/6b1f…9c04"},
    "evidence_digests_hex": {"6b1f…9c04"},
    "fail_mode": "closed",
  },
}
```

and ships a built-in **default policy** that cannot be removed:

```rego
package gatekeeper.default

default allow := false

allow if {
  input.attestation.verified == true
  some digest in data.gatekeeper.trust.endpoints[input.endpoint].evidence_digests
  digest == input.evidence.evidenceDigest
}
```

`input.evidence.evidenceDigest` is normalised to canonical form before evaluation, so the comparison is
exact-string. The exact `input` document is `schemas/rego-input.schema.json`
(`docs/contracts/rego-input.md`), a superset of swarm-cloud's `buildRegoInput` with `application` renamed
to `endpoint`.

### 5. User policies are ANDed

`policies[]` lists user Rego files (global — every endpoint). Each file must declare a distinct package
and define `allow`. Admission requires **every** loaded package's `allow` to be `true`:

```
admit ⇔ verifier ok ∧ ∀ p ∈ {gatekeeper.default} ∪ userPackages : data[p].allow == true
```

Rules: a package without an `allow` rule → load error; an evaluation error or `undefined` → deny; a
policy cannot widen trust, only narrow it (the default pin check always applies). `gatekeeper policy test
--bundle <file> [--config …]` evaluates the full pipeline offline against a saved bundle and prints every
package's result — the `data.gatekeeper.trust` module is generated from the same config.

### 6. Fail-closed by default; fail-open is explicit and loud

`failMode: closed` (default): while the endpoint has no valid verdict — never verified, denied, or
re-attestation failed — the local listener answers **503** with an OpenAI-style error body
(`{"error":{"type":"gatekeeper_error","code":"attestation_failed","message":"<stage>: <reason>"}}`) and
does **not** open an upstream connection. `failMode: open` proxies anyway, logs at `warn`, sets
`X-Gatekeeper-Verdict: deny` on the **client-facing** response, and the TUI paints the endpoint amber.
Verdict headers are added on the way back to the local client only; **nothing about the verdict is ever
sent upstream** (no request header, no query parameter, no separate call).

### 7. Re-attestation and verdict cache

- `reattestInterval` (default `5m`): a background loop per endpoint re-runs the full pipeline (fresh TLS
  handshake, fresh bundle fetch). Requests are admitted against the **last verdict**; the data plane never
  blocks on verification except for the very first request, which waits for the initial verdict
  (`initialTimeout`, default `15s`).
- `verdictCacheTtl` (default `60s`): a re-check the data plane triggers **on its own** — the first request
  of an endpoint's life, or a connection whose certificate did not match the pin — reuses a verdict younger
  than the TTL, so a burst of failures cannot become a burst of handshakes against the upstream. An
  **explicit** re-check does not: `gatekeeper verify` and the dashboard's "Re-attest now" bypass the cache,
  which is what `status.Supervisor.Reattest` promises and what a user who has just edited a pin is asking
  for. *(Amended 2026-08-31, SUP-71: this bullet previously had the explicit re-check reusing the cached
  verdict, which contradicted both the interface contract and the shipped TUI help.)* The cache is keyed by
  `(hostname, observedTlsFingerprint, trustedRootsDigest, maxBundleAge, policyHash)`; in the implementation
  the last three are covered by rebuilding the verifier — and with it the cached verdict — whenever the
  configuration is reloaded, so a policy or pin edit takes effect on the next check instead of waiting out
  the TTL.
- `maxBundleAge` (default `24h`, matching the desktop gatekeeper): bundles older than this fail at `jws`;
  a 60 s clock-skew tolerance is allowed for future-dated bundles.
- A **change of the observed TLS leaf** between re-attestations (cert rotation) invalidates the verdict
  immediately and triggers a re-check — the pipeline handles rotation because the platform re-signs the
  bundle with the new fingerprint.
- A verdict flip from allow → deny under `failMode: closed` closes in-flight upstream connections; under
  `open` they continue.

### 8. Config file

`~/.config/confidential-gatekeeper/config.yaml` (override `--config`, env `GATEKEEPER_CONFIG`); schema
`schemas/gatekeeper-config.schema.json`, example `schemas/examples/gatekeeper-config.example.yaml`. Secrets
never live in the file: the gatekeeper does not hold the router API key — the client sends
`Authorization: Bearer sk-tee-…` through the proxy untouched.

Two optional sections belong to the running proxy (SUP-71). `admin.listen` (`unix:<path>` or a **loopback**
`host:port`, enforced) exposes the read-only status API — `/healthz`, `/status`, `/endpoints`, `/verdicts`,
`/metrics` — which is how `gatekeeper status` reports on a gatekeeper running in another process; there is
deliberately no route that can start, stop, pin or re-attest. `audit.file` appends one JSON object per line
for every verdict change, every refused request and every request a `failMode: open` endpoint forwarded
without one — and never a request body, a response body or a query string. `metrics.listen` keeps serving
`/metrics` and `/healthz` only, since a scrape endpoint reaches further than the verdict routes should.

## Consequences

- Implementation tasks: SUP-68 (verifier), SUP-69 (config + trust store + OPA), SUP-71 (data plane),
  SUP-72 (CLI/TUI), SUP-114 (§2a, the attested-root anchor). They all code against the schemas in
  `/schemas`.
- §2a adds two dependencies the gatekeeper did not have — `github.com/google/go-sev-guest` and
  `github.com/google/go-tdx-guest` — and one thing it did not do: it reaches the network for artefacts and
  for the registry. Both are confined to the attested path, both are content-addressed or signature-checked,
  and both fail closed, so a gatekeeper configured with manual roots alone still works entirely offline.
- The Rego engine is the real OPA (`github.com/open-policy-agent/opa/rego`), Rego v1 syntax; policies
  written for the gatekeeper run unchanged under `opa eval`.
- One custom built-in ships in v1: `custom.tree_match(pattern, actual)`, a port of the Rust gatekeeper's
  built-in of the same name (every key of `pattern` must be present in `actual` with an equal value;
  objects recurse; keys only in `actual` are ignored). It exists so that "match a subtree of the
  snapshot" policies do not have to be written with `walk()`, and so that policies move over from the
  Rust gatekeeper unchanged. Policies that use it need `opa eval` to be given the same built-in.
