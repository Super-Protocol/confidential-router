# Gatekeeper Rego contract

Machine-readable form: `schemas/rego-input.schema.json` (+ `schemas/examples/rego-input.example.json`).
Derived from swarm-cloud `apps/gatekeeper-proxy/src/evidence.ts:buildRegoInput` with `application` renamed
to `endpoint` and the attestation block extended. Rego v1 syntax, evaluated by embedded OPA (ADR-003).

## `input`

```jsonc
{
  "endpoint": "llama-33-70b",                       // endpoints[].name from config
  "upstream": { "hostname": "llama-33-70b.tee.swarm.cloud", "port": 443 },
  "attestation": {
    "verified": true,                               // always true when Rego runs (pipeline stages 1–6 passed)
    "channelBinding": "observed",                   // gatekeeper never uses producer-asserted
    "root": "swarm-cloud-prod",                     // matched trustedRoots[].name
    "rootFingerprint": "sha256/…",                  // SHA-256 of the matched root DER
    "observedTlsFingerprint": "sha256/…",
    "verifiedAt": "2026-08-30T10:11:04Z",
    "quoteFormat": "intel-tdx-quote-v5"             // bundle.rootCaTeeQuote.format, if present
  },
  "evidence": {                                     // the verified JWS payload, plus convenience fields
    "version": "1",
    "kind": "DeploymentEvidence",
    "hostname": "llama-33-70b.tee.swarm.cloud",
    "issuedAt": "2026-08-30T10:05:00Z",
    "certFingerprint": "sha256/…",
    "evidenceDigest": "sha256/…",                   // normalised to canonical form
    "evidence": { "version": 2, "resources": [ … ] }, // canonical deployment snapshot as published
    "containerImages": ["ghcr.io/…/router-api@sha256:…", "ghcr.io/…/vllm-tdx@sha256:…"],
    "evidenceDigestHex": "6b1f…9c04",             // the spelling every screen and command shows
    "certFingerprintHex": "…"
  }
}
```

The `*Hex` fields are the ergonomic comparands: a constant in a policy is
usually a string someone copied out of the router console or off a `gatekeeper
verify` report, and both print `sha256:<hex>`. Compare against `evidenceDigestHex`
with the scheme dropped, or against `evidenceDigest` if the canonical
`sha256/<base64url>` form the bundle carries is what you already hold.

`evidence.evidence` is opaque to the gatekeeper; policies that inspect it use `walk()` or
`object.get`. `containerImages` is the flattened list of every string `image` field in the snapshot
(swarm-cloud `collectImages`), deduplicated, order-insensitive.

## `data.gatekeeper.trust` (generated from config, read-only)

```jsonc
{
  "roots":     { "<root name>": { "fingerprint": "sha256/…" } },
  "endpoints": { "<endpoint name>": {
      "hostname": "…",
      "evidence_digests": {"sha256/…", …},          // a Rego set, canonical form
      "evidence_digests_hex": {"…", …},
      "fail_mode": "closed" | "open"
  } }
}
```

## Built-in default policy (always loaded, cannot be disabled)

```rego
package gatekeeper.default

default allow := false

allow if {
  input.attestation.verified == true
  some digest in data.gatekeeper.trust.endpoints[input.endpoint].evidence_digests
  digest == input.evidence.evidenceDigest
}
```

## User policy example (`policies[]`)

```rego
package user.images

default allow := false

# Only allow if every container image in the snapshot is from our registry and digest-pinned.
allow if {
  count(input.evidence.containerImages) > 0
  every img in input.evidence.containerImages {
    startswith(img, "ghcr.io/super-protocol/")
    contains(img, "@sha256:")
  }
}
```

Admission ⇔ verifier ok ∧ `data.gatekeeper.default.allow` ∧ every user package's `allow`. A package
without `allow` fails to load; an error/undefined evaluates as deny. `gatekeeper policy test --bundle
bundle.json --config config.yaml [--endpoint name]` runs the identical evaluation offline and prints per-package results.
