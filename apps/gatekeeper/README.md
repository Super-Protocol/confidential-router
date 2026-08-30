# gatekeeper

The **Gatekeeper** is the user-side half of the Confidential Router trust model:
a single static Go binary that runs on the user's machine, verifies the evidence
a router endpoint publishes at `/.well-known/swarm-evidence`, and only then
proxies traffic to it.

The router never learns whether, when, or by whom it was attested — it only
*publishes* evidence. All verdicts are formed here.

## Status

The binary itself is still a skeleton — it only reports its build identity —
but everything underneath it is in place: configuration, the trust store and
the embedded OPA policy engine (SUP-69), and the verification pipeline
(`pkg/attestation`, SUP-68). The data plane (SUP-71) lands next.

```bash
pnpm nx run gatekeeper:build   # -> apps/gatekeeper/bin/gatekeeper
pnpm nx run gatekeeper:test    # -> go test ./...
pnpm nx run gatekeeper:lint    # -> go vet ./... && golangci-lint run
pnpm nx run gatekeeper:serve   # -> go run ./cmd/gatekeeper
```

## Layout

| Path                     | Purpose                                                                 |
| ------------------------ | ----------------------------------------------------------------------- |
| `cmd/gatekeeper/`        | CLI entry point. Thin — argument parsing and wiring only.                 |
| `pkg/`                   | All reusable logic, importable by third parties and by a future desktop shell. |
| `pkg/attestation/`       | Verifier for `/.well-known/swarm-evidence`: fetch with observed TLS binding, chain, trusted root, JWS (RS256/ES256K), freshness. [Details](pkg/attestation/README.md). |
| `pkg/config/`            | YAML configuration: load (defaults → file → env → flags), validate, and rewrite in place. |
| `pkg/trust/`             | Trusted roots and per-endpoint pinned `evidenceDigest` values; digest parsing and normalisation. |
| `pkg/policy/`            | Embedded OPA: the generated trust module, the built-in pin policy, user policies. |
| `pkg/policy/testing/`    | Offline evaluation of a saved bundle — what `gatekeeper policy test` runs. |
| `pkg/version/`           | Build identity, stamped by GoReleaser via `-ldflags`.                    |

Keeping the verification pipeline, trust store and proxy in `pkg/` (never in
`internal/`) is a deliberate constraint from the parent design: an Electron
desktop shell must be able to embed the core later.

## Trust layer

Everything here implements [ADR-003](../../docs/adr/ADR-003-gatekeeper-trust-model.md)
and the schemas in [`/schemas`](../../schemas); read those first.

### Configuration (`pkg/config`)

`~/.config/confidential-gatekeeper/config.yaml` by default
(`--config`, `$CR_GATEKEEPER_CONFIG`, or `$GATEKEEPER_CONFIG`). Values resolve
in four layers, later ones winning:

```
built-in defaults  →  the file  →  CR_GATEKEEPER_*  →  command-line flags
```

Per-endpoint knobs resolve through their own chain: built-in → `defaults:` →
the endpoint → `CR_GATEKEEPER_*` (global, then `CR_GATEKEEPER_ENDPOINT_<NAME>_*`)
→ flags. `<NAME>` is the endpoint name upper-cased with `-` replaced by `_`.
An unrecognised `CR_GATEKEEPER_*` variable is a startup error rather than a
silent no-op — a typo in a deployment unit must not leave the old value in place.

Validation reports every problem at once, each addressed by its path
(`endpoints[1].trustedEvidence[0]: is not an evidenceDigest …`). Unknown keys
are rejected: a mistyped `trustedEvidance` would otherwise mean an endpoint
running with the wrong pins.

Edits (`gatekeeper trust add …`) go through `config.Document`, which rewrites
the file through the yaml.v3 node API — comments, key order and block scalars
survive — and saves atomically.

### Trust store (`pkg/trust`)

Global trusted roots (matched by the SHA-256 of the root DER) and, per endpoint,
the pinned `evidenceDigest` values. Digests are canonical `sha256/<base64url>`;
`sha256:<hex>` and bare hex are accepted on input and normalised, so a pin
copied out of a log matches one copied out of the console.

`Store.Hash()` fingerprints the whole trust state and belongs in the verdict
cache key, so editing a pin takes effect on the next check instead of waiting
out the TTL.

### Policy engine (`pkg/policy`)

Embedded OPA (Rego v1) over three kinds of module:

- `gatekeeper.trust` — generated from the trust store on every load;
- `gatekeeper.default` — the built-in pin policy, always loaded;
- the user's `policies[]`.

A request is admitted only if **every** loaded package's `allow` is true, so a
user policy can narrow trust but never widen it. Compile problems — a syntax
error, a package without `allow`, a policy trying to redeclare
`gatekeeper.default` — are fatal at load. At request time an evaluation error
or an undefined result is a deny.

`pkg/policy/testing` evaluates a saved bundle offline (`gatekeeper policy test`).
Without a verifier it runs **policy-only**: the JWS payload is decoded without
checking the signature, chain or freshness, so `Result.Admitted` is false
whatever the policies said, and every shortcut is listed in `Result.Warnings`.
`Options.Verify` is the seam `pkg/attestation` plugs into to make the run a real
end-to-end check.

`custom.tree_match(pattern, actual)` is available to policies: every key of
`pattern` must be present in `actual` with an equal value, objects recurse, and
keys only in `actual` are ignored. It is a port of the Rust gatekeeper's
built-in of the same name, so policies move over unchanged.

## Toolchain

Go 1.24.6 (`go.mod`, the floor OPA sets). With Go 1.21+ and `GOTOOLCHAIN=auto` (the default) an older
local Go will fetch the pinned toolchain automatically.

`golangci-lint` v2 is required for the `lint` target —
[installation instructions](https://golangci-lint.run/docs/welcome/install/).
