# Contributing

Thanks for taking the time to contribute. This document covers the mechanics;
[README.md](./README.md) covers what the project is.

## Getting set up

```bash
nvm use                # Node 24, per .nvmrc
corepack enable        # pnpm 11, pinned via packageManager
pnpm install
pnpm verify            # lint + typecheck + build + test
```

Go work additionally needs Go 1.26 and
[golangci-lint v2.13+](https://golangci-lint.run/docs/welcome/install/) — a
golangci-lint whose own Go is older than `apps/gatekeeper/go.mod`'s `go`
directive refuses to load the config.

Cutting a gatekeeper release is `git tag gatekeeper-v<semver> && git push --tags`;
see [`apps/gatekeeper/README.md`](./apps/gatekeeper/README.md#releases).

## Branch model

`main` is protected and always releasable. All changes land through a pull
request that is **squash-merged** into `main`; direct pushes are rejected.

Branch names:

| Prefix      | Use for                          |
| ----------- | -------------------------------- |
| `feature/`  | new behaviour                    |
| `bugfix/`   | fixes to shipped behaviour       |
| `chore/`    | tooling, CI, dependencies, docs  |

## Commits

[Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) are
enforced in CI (`commitlint`) against the PR title, which becomes the squash
commit subject:

```
feat(gatekeeper): pin evidence digests per endpoint
fix(router-api): stop leaking upstream error bodies
chore(ci): cache the pnpm store
```

Allowed scopes are free-form; prefer the project directory name
(`gatekeeper`, `router-api`, `router-ui`, `types`, `ci`, `deps`).

## Pull requests

Every PR body uses the template and must fill in:

- **`## Summary`** — what changed and why, in prose.
- **`## Test plan`** — every test you added, or an explicit reason none were
  needed.

CI runs `nx affected -t lint build test typecheck` plus the Go checks
(`go vet`, `go test ./...`, `golangci-lint run`). A PR is mergeable when CI is
green and a code owner has approved.

## Code standards

- **English everywhere** — code, comments, commits, PR descriptions, docs.
- **Biome** is the single source of truth for TypeScript formatting and
  linting; `gofmt`/`goimports` for Go. Run `pnpm lint-fix` before pushing.
- **Tests are not optional.** New logic gets unit tests; anything crossing a
  process boundary gets an e2e test.
- **Never hand-edit generated code** (GraphQL clients, and similar) — regenerate
  it.
- **The gatekeeper is fail-closed by default.** Fail-open must stay an explicit,
  per-endpoint opt-in.
- **No `@swarm-cloud/*` dependencies.** Port code by copying and record the
  provenance in [`NOTICE`](./NOTICE).

## Adding a project to the workspace

Nx infers targets rather than declaring them:

- A TypeScript project needs `package.json`, `tsconfig.json` +
  `tsconfig.lib.json` (+ `tsconfig.spec.json`), a `vitest.config.mts`, and a
  `biome.json` containing `{ "root": false, "extends": "//" }`. That last file
  is what gives it `lint` / `lint-fix`.
- A non-TypeScript project (Go) declares its targets explicitly in a
  `project.json` using `nx:run-commands` — see `apps/gatekeeper/project.json`.
- Register new path aliases in `tsconfig.base.json` and add a reference in the
  root `tsconfig.json`.

## Code of conduct

Participation is governed by the [Code of Conduct](./CODE_OF_CONDUCT.md).
