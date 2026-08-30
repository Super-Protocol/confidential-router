# ADR-003 — Trust model of the gatekeeper

- **Status:** Accepted
- **Date:** 2026-08-30
- **Decided by:** Denis (decisions 2, 4, 6), CTO (Rego semantics, cache, re-attestation)

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
import rego.v1

default allow := false

allow if {
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
- `verdictCacheTtl` (default `60s`): an on-demand re-check (e.g. `gatekeeper verify`, TUI "Re-attest now")
  reuses a verdict younger than the TTL; keyed by
  `(hostname, observedTlsFingerprint, trustedRootsDigest, maxBundleAge, policyHash)` — the policy hash makes
  a policy or pin edit take effect on the next check instead of waiting out the TTL.
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

## Consequences

- Implementation tasks: SUP-68 (verifier), SUP-69 (config + trust store + OPA), SUP-71 (data plane),
  SUP-72 (CLI/TUI). They all code against the schemas in `/schemas`.
- The Rego engine is the real OPA (`github.com/open-policy-agent/opa/rego`), Rego v1 syntax; policies
  written for the gatekeeper run unchanged under `opa eval`.
- Custom built-ins are not needed for v1; swarm-cloud's Rust `custom.tree_match` idea is noted for a
  later "match a subtree of the snapshot" helper if `walk()`-based policies prove too verbose.
