# ADR-001 — Repository & language split

- **Status:** Accepted
- **Date:** 2026-08-30
- **Decided by:** Denis (naming/license/distribution decisions 1, 7, 8), CTO (structure)

## Context

Confidential Router ships two very different artefacts:

1. **Router** — a multi-tenant web service (OpenAI-compatible REST gateway + GraphQL console API) and a
   Next.js console. Long-running, DB-backed, deployed by the operator inside a confidential cluster.
2. **Gatekeeper** — a user-side attesting forward proxy. Installed by end users on laptops and in CI as a
   single static binary, no runtime dependencies, must embed a policy engine (OPA/Rego) and a terminal UI.

The existing Swarm Cloud code base (`Super-Protocol/swarm-cloud`, BSL-1.1) already contains the pieces we
need — the `/.well-known/swarm-evidence` verifier (`libs/swarm-attestation`), a desktop gatekeeper
(Electron), a Rego-gated proxy (`apps/gatekeeper-proxy`, TypeScript, shells out to `opa`), and a Rust
S3/registry gatekeeper (`apps/swarm-gatekeeper`, regorus). None of them is the product we are building,
and this repository is going to be published as open source under a different license.

## Decision

1. **Standalone repository `Super-Protocol/confidential-router`, Apache-2.0.** No build or runtime
   dependency on swarm-cloud. Code is ported by copying with attribution (a header comment
   `// Ported from Super-Protocol/swarm-cloud <path> @ <sha>` and a `NOTICE` entry); npm scope is
   `@confidential-router/*`, never `@swarm-cloud/*`.
2. **Nx multi-language monorepo.** Same TypeScript stack as swarm-cloud (pnpm, Nx, Biome, TypeScript
   strict, NestJS + Apollo code-first GraphQL + TypeORM, Next.js App Router + React + Tailwind 4 +
   Radix/shadcn). Go projects are wired into Nx with `nx:run-commands` targets (`build`, `test`, `lint`,
   `serve`) — the same pattern swarm-cloud uses to wrap cargo in `apps/swarm-gatekeeper/project.json` — so
   `nx affected -t lint test build` is the single CI entry point for both languages.
3. **Router in TypeScript** (`apps/router-api`, `apps/router-ui`, `libs/attestation`, `libs/ui`,
   `libs/types`). Rationale: the console is a React app, the evidence verifier already exists in TS, the
   team's NestJS/TypeORM conventions carry over unchanged, and the router is a plain service where
   Node's HTTP stack (including SSE passthrough) is adequate.
4. **Gatekeeper in Go** (`apps/gatekeeper`, module
   `github.com/Super-Protocol/confidential-router/apps/gatekeeper`). Rationale:
   - OPA is a Go library (`github.com/open-policy-agent/opa/rego`) — the Rego engine is embedded, no
     `opa` binary on `PATH` (swarm-cloud's `gatekeeper-proxy` shells out; that is not acceptable for a
     user-installed tool).
   - `CGO_ENABLED=0` yields a single static binary per OS/arch; GoReleaser + GitHub Releases is the
     distribution decision (decision 7). Cross-compiling from CI is trivial.
   - `crypto/tls` gives direct access to the observed leaf certificate (`ConnectionState().PeerCertificates[0]`)
     for channel binding, and `net/http/httputil.ReverseProxy` streams SSE/WebSocket bodies without buffering.
   - TUI-only UI (decision 8) maps onto Charm `bubbletea`/`lipgloss`.
   - Rust (regorus, as in `apps/swarm-gatekeeper`) was considered; it wins on binary size but loses on
     OPA compatibility (regorus is a reimplementation with gaps) and on team velocity.
5. **Gatekeeper core is a library.** Everything below the CLI lives under `apps/gatekeeper/pkg/`
   (`attestation`, `trust`, `policy`, `proxy`, `config`), importable by a future desktop shell; `cmd/gatekeeper`
   and `internal/tui` are thin. Desktop (Electron) is out of scope.
6. **Language-neutral conformance fixtures** live in `libs/attestation-fixtures` (JSON bundles, chains,
   expected verdicts per stage). Both the TS verifier (`libs/attestation`) and the Go verifier
   (`apps/gatekeeper/pkg/attestation`) run the same vectors, so the two implementations cannot drift.

## Layout

```
apps/router-api        NestJS: /v1/* OpenAI-compatible REST + /graphql for the console, TypeORM (PostgreSQL prod, SQLite dev)
apps/router-ui         Next.js console (9 screens)
apps/gatekeeper        Go: cmd/gatekeeper, pkg/{attestation,trust,policy,proxy,config}, internal/tui
apps/*-e2e             Playwright (UI) / vitest (API) / Go integration tests
libs/attestation       TS verifier of /.well-known/swarm-evidence (ported from swarm-cloud libs/swarm-attestation)
libs/attestation-fixtures  conformance vectors shared by TS and Go
libs/ui                shared React components + design tokens
libs/types             shared TS contracts: DTOs, JSON schemas (+ ajv tests), generated types
schemas/               JSON Schemas + example configs (source of truth for libs/types and the Go config loader)
docs/adr, docs/contracts, docs/threat-model.md
docker/                docker-compose dev/demo stack (PostgreSQL, mock LiteLLM, mock evidence publisher)
.github/workflows      PR checks (nx affected + go vet/test/golangci-lint), releases (GoReleaser, ghcr)
```

## Consequences

- Two toolchains in CI (Node 24 + Go 1.23+); the PR workflow installs both. Go lint = `golangci-lint`,
  TS lint = Biome.
- Contracts that both languages consume (config schema, Rego input, evidence bundle) are defined **once**
  as JSON Schema under `/schemas` (ADR-003, `/schemas/README.md`). The Go side embeds the schema files via
  `go:embed` and validates with `santhosh-tekuri/jsonschema`; the TS side validates with `ajv` in `libs/types`.
- Ported code keeps its original structure to make later back-porting of fixes practical.
