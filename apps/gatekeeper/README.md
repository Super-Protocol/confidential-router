# gatekeeper

The **Gatekeeper** is the user-side half of the Confidential Router trust model:
a single static Go binary that runs on the user's machine, verifies the evidence
a router endpoint publishes at `/.well-known/swarm-evidence`, and only then
proxies traffic to it.

The router never learns whether, when, or by whom it was attested — it only
*publishes* evidence. All verdicts are formed here.

## Status

The verifier (`pkg/attestation`) is implemented and covered by conformance
vectors. The CLI is still the bootstrap skeleton and only reports its build
identity:

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
| `pkg/version/`           | Build identity, stamped by GoReleaser via `-ldflags`.                    |
| `pkg/attestation/`       | Verifier for `/.well-known/swarm-evidence`: fetch with observed TLS binding, chain, trusted root, JWS (RS256/ES256K), freshness. [Details](pkg/attestation/README.md). |

Keeping the verification pipeline, trust store and proxy in `pkg/` (never in
`internal/`) is a deliberate constraint from the parent design: an Electron
desktop shell must be able to embed the core later.

## Toolchain

Go 1.24 (`go.mod`). With Go 1.21+ and `GOTOOLCHAIN=auto` (the default) an older
local Go will fetch the pinned toolchain automatically.

`golangci-lint` v2 is required for the `lint` target —
[installation instructions](https://golangci-lint.run/docs/welcome/install/).
