# Confidential Router

An OpenRouter-style, token-metered LLM router where **every model runs inside a
TEE and publishes signed attestation evidence** — plus the **Gatekeeper**, a
user-side attesting proxy that verifies that evidence before letting your
traffic through.

> **Status: bootstrap.** This repository currently contains the workspace,
> toolchain and CI scaffolding only. The router API, console and gatekeeper
> features land incrementally.

## The one architectural rule

**The router does not know when, whether, or by whom it is attested.**

Verification happens entirely on the user's side, inside the Gatekeeper. The
router only *publishes* evidence (quotes, JWS, certificate chains) and meters
generations; it never stores or reports a verification verdict. There is no
gatekeeper registration, no instance list, and no "verified" badge anywhere in
the router.

## How it fits together

```
  your app ──► gatekeeper (localhost)  ──►  router endpoint (TEE)  ──►  models (LiteLLM, same cluster)
                    │                              │
                    │  1. GET /.well-known/swarm-evidence
                    │  2. chain leaf→root, root ∈ trusted roots
                    │  3. verify JWS (RS256 / ES256K) with leaf key
                    │  4. freshness (issuedAt, max age)
                    │  5. channel binding: payload.certFingerprint == observed TLS leaf
                    │  6. Rego policies — every loaded package must yield allow == true
                    └─ fail-closed by default
```

## Repository layout

```
apps/
  router-api/            NestJS — OpenAI-compatible REST (/v1/*) + GraphQL for the console
  router-ui/             Next.js console
  gatekeeper/            Go — attesting forward proxy: CLI + TUI, embedded OPA/Rego   ✅ scaffolded
  *-e2e/                 Playwright (UI) / vitest (API) / Go integration tests
libs/
  attestation/           TS verifier of the /.well-known/swarm-evidence contract           ✅ scaffolded
  attestation-fixtures/  language-neutral conformance vectors shared by the TS and Go verifiers ✅
  ui/                    shared React components + design tokens
  types/                 shared TS contracts (API DTOs, config schemas)              ✅ scaffolded
  nx-biome/              local Nx plugin: infers lint / lint-fix targets from biome.json ✅
docker/                  dev/demo compose stack
.github/workflows/       PR checks and release workflows
```

Directories without a ✅ are the planned shape, not yet present.

## Quick start

Prerequisites: **Node 24** (see `.nvmrc`), **pnpm 11**, **Go 1.24**,
**golangci-lint v2**, and Docker for the dev services.

```bash
pnpm install                 # also compiles the local nx-biome plugin (prepare script)
pnpm verify                  # lint + typecheck + build + test across the workspace

pnpm dev:up                  # PostgreSQL 16 on :5432 (docker/docker-compose.dev.yml)
pnpm dev:down
```

Per-target:

```bash
pnpm nx run-many -t lint typecheck build test
pnpm nx run gatekeeper:test         # go test ./...
pnpm nx affected -t lint build test # what CI runs on a PR
pnpm nx graph
```

## Toolchain

| Tool           | Version | Notes                                                              |
| -------------- | ------- | ------------------------------------------------------------------ |
| Node           | 24      | `.nvmrc`; `engines` allows ≥22.11 so a slightly older LTS still installs |
| pnpm           | 11      | workspaces: `apps/*`, `libs/*`                                      |
| Nx             | 23      | inference plugins — no hand-written targets for TS projects         |
| Biome          | 2.5     | formatter + linter; 2-space, width 120, single quotes               |
| TypeScript     | 5.9     | `strict`, `nodenext`, project references                            |
| Go             | 1.24    | `apps/gatekeeper`, wired into Nx via `nx:run-commands`              |

TypeScript path aliases use the `@confidential-router/*` scope and are declared
once in `tsconfig.base.json`.

## Relationship to swarm-cloud

This repository is **standalone**: it has no build or runtime dependency on
[swarm-cloud](https://github.com/Super-Protocol/swarm-cloud). Shared logic is
ported by copying, with attribution recorded in [`NOTICE`](./NOTICE). Never add
an `@swarm-cloud/*` dependency here.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the branch model, commit
convention and PR checklist, and [SECURITY.md](./SECURITY.md) for reporting
vulnerabilities.

## License

[Apache License 2.0](./LICENSE).
