# Confidential Router

An OpenRouter-style, token-metered LLM router where **every model runs inside a
TEE and publishes signed attestation evidence** — plus the **Gatekeeper**, a
user-side attesting proxy that verifies that evidence before letting your
traffic through.

> **Status: early.** The workspace, the architecture decision records and the
> `router-api` foundation (configuration, database, authentication, health) are
> in place. The OpenAI-compatible gateway, the console and the gatekeeper land
> incrementally.

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
  router-api/            NestJS — config, TypeORM, auth, health, GraphQL           ✅ foundation
  router-ui/             Next.js console — app shell, design tokens, auth pages   ✅ scaffolded
  gatekeeper/            Go — attesting forward proxy: CLI + TUI, embedded OPA/Rego   ✅ scaffolded
  router-ui-e2e/         Playwright smoke + axe accessibility suite for the console  ✅ scaffolded
  *-e2e/                 vitest (API) / Go integration tests
libs/
  attestation/           TS verifier of the /.well-known/swarm-evidence contract           ✅ scaffolded
  attestation-fixtures/  language-neutral conformance vectors shared by the TS and Go verifiers ✅
  server-common/         config loading (YAML + env + Zod) and structured logging     ✅
  ui/                    shared React components + design tokens                 ✅ scaffolded
  types/                 shared TS contracts (API DTOs, config schemas)              ✅ scaffolded
  nx-biome/              local Nx plugin: infers lint / lint-fix targets from biome.json ✅
docker/                  dev + demo compose stacks, and the two demo stand-ins  ✅
.github/workflows/       PR checks and release workflows                        ✅
```

Directories without a ✅ are the planned shape, not yet present.

## Try it

The whole thing in containers — console, API, PostgreSQL, plus a mock model
backend and a mock evidence publisher — from a clean clone:

```bash
make up          # http://localhost:3001, first run builds two images
make down
```

Sign in with a magic link (the API prints it to the log; no mail provider
needed), top up on the Credits screen, mint a key, and point any OpenAI client
at `http://localhost:3000/v1`. See [`docker/README.md`](./docker/README.md) —
including why that stack is a demo and not a deployment.

## Quick start

Prerequisites: **Node 24** (see `.nvmrc`), **pnpm 11**, **Go 1.24**,
**golangci-lint v2**, and Docker for the dev services.

```bash
pnpm install                 # also compiles the local nx-biome plugin (prepare script)
pnpm verify                  # lint + typecheck + build + test across the workspace

pnpm dev:up                  # PostgreSQL 16 on :5432 (docker/docker-compose.dev.yml)
pnpm dev:down
```

Run the API — no configuration file, no environment variables, SQLite:

```bash
pnpm nx serve router-api     # http://localhost:3000/health, /graphql, /docs
```

See [`apps/router-api/README.md`](./apps/router-api/README.md) for configuration,
migrations and the authentication flow.

Per-target:

```bash
pnpm nx run-many -t lint typecheck build test
pnpm nx run gatekeeper:test         # go test ./...
pnpm nx run router-api:migrate      # apply pending database migrations
pnpm ui:dev                         # the console on http://localhost:3001
pnpm nx run @confidential-router/router-ui-e2e:e2e   # Playwright smoke + axe audit
pnpm nx affected -t lint build test # what CI runs on a PR
pnpm nx graph

make images                         # build the router-api and router-ui images
make up                             # the demo stack; make up-core omits the mocks
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
| NestJS         | 11      | `apps/router-api`; Apollo code-first GraphQL, TypeORM 0.3           |
| PostgreSQL     | 16      | production store; SQLite in development, tests and CI unit runs     |

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
