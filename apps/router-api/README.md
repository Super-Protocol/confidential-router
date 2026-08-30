# router-api

The Confidential Router backend: an OpenAI-compatible `/v1` gateway plus the
GraphQL API behind the console. This is the foundation — configuration,
persistence, authentication, health — that the metering gateway (SUP-73) and the
console (SUP-72) build on.

## Quick start

```bash
pnpm nx serve router-api
```

That boots on SQLite with no configuration file and no environment variables:
the schema defaults are a working development setup, migrations run at startup,
and the database lands in `data/router-api.sqlite`. Then:

- `http://localhost:3000/health` — liveness plus a real database round-trip
- `http://localhost:3000/graphql` — Apollo, `{ me { id email } }`
- `http://localhost:3000/docs` — Swagger UI for the REST surface
- `http://localhost:3000/auth/*` — Better Auth

Sign in without configuring a mail provider: `POST /auth/sign-in/magic-link` with
`{"email":"you@example.com","callbackURL":"/"}`, then open the link the log
prints.

## Configuration

Two sources, later wins:

1. `conf/router.yaml` — looked up under the working directory first, then beside
   the running bundle. Override the path with `CR_API_CONFIG_FILE`.
2. `CR_API_*` environment variables. `__` separates object levels and each level
   is read as snake_case: `CR_API_SERVER__PORT=4000` sets `server.port`,
   `CR_API_AUTH__GITHUB__CLIENT_ID` sets `auth.github.clientId`.

Both are validated once, at boot, against the Zod schema in
`src/app/config.schema.ts` — the runtime mirror of
[`schemas/router-config.schema.json`](../../schemas/router-config.schema.json).
A test parses the committed example against both so they cannot drift.

Values in the YAML may reference the environment as `${VAR}` or `${VAR:-default}`;
an unset placeholder with no default fails the boot rather than surfacing later
as a confusing validation error.

Two settings behave differently in production:

| Setting | Development | Production (`NODE_ENV=production`) |
| --- | --- | --- |
| `auth.secret` | minted per process, with a warning | required; the boot fails without it |
| `auth.magicLink.mailer: console` | prints the link to the log | rejected — configure `resend` |

## Database

PostgreSQL in production, SQLite everywhere else. The schema is portable by
construction: timestamps are epoch milliseconds in a `bigint`, money and counters
are `bigint` read back as `number`, structured payloads are JSON in `text`. See
`src/app/db/columns.ts` and [`docs/contracts/data-model.md`](../../docs/contracts/data-model.md).

`synchronize` is off on both drivers. Migrations own the schema, so what a
developer runs against is what CI and production get:

```bash
# apply everything (Better Auth's four tables, then this service's ten)
pnpm nx run router-api:migrate
```

`database.migrationsRun` defaults to `true` on SQLite (so `nx serve` works on an
empty directory) and `false` on PostgreSQL, where a deployment runs the command
above once from a job rather than racing every replica.

`src/app/db/migrations.spec.ts` asserts that the migrated schema is *exactly* the
schema the entities describe, on both databases — the PostgreSQL half runs when
`CR_TEST_POSTGRES_URL` is set, which CI does.

## Authentication

Better Auth (ADR-004), mounted at `/auth/*`, sharing the one database. OAuth
(GitHub, Google) and email magic link; no passwords, no wallet, no second store.
Better Auth owns `user`, `session`, `account` and `verification` and migrates them
itself; this service's TypeORM migration owns the other ten tables and takes no
database-level foreign key on `user`, so the two stay independent.

In application code the surface is deliberately small:

```ts
@Query(() => ViewerModel)
@UseGuards(SessionGuard)
async me(@CurrentUser() user: SessionUser) { … }
```

`SessionGuard` works for REST and GraphQL alike and accepts a session cookie and
nothing else — `/v1/*` will authenticate with `Authorization: Bearer sk-tee-v1-…`
through a separate guard, and the two are never interchangeable.

Every workspace-scoped read goes through `WorkspaceScopeService`, which is the
single place tenancy is enforced.

## Layout

```
src/
  main.ts                 process entry; bootstrap.ts holds the middleware stack
  app/
    config.ts             two-source loader + Zod schema
    db/                   entities, portable column presets, DataSource factory
    auth/                 Better Auth, guards, workspace scoping and provisioning
    api/health            /health
    api/graphql           Apollo code-first schema (`me`)
  migrations/             TypeORM migrations, imported explicitly for bundling
  cli/run-migrations.ts   the migration command a deployment runs
test/                     supertest e2e against the real module graph
```

## Tests

```bash
pnpm nx test router-api                                   # unit + e2e, on SQLite
CR_TEST_POSTGRES_URL=postgres://… pnpm nx test router-api  # adds the PostgreSQL suite
```

The e2e suites boot the real `AppModule` with the real middleware stack and swap
only the mailer, so a CORS or Helmet difference between tests and production
cannot hide.
