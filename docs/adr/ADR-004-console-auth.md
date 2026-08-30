# ADR-004 — Console authentication

- **Status:** Accepted
- **Date:** 2026-08-30
- **Decided by:** Denis (decision 3)

## Context

swarm-cloud authenticates with MetaMask/SIWE plus OAuth through a separate `auth-service` backed by
MongoDB. Confidential Router is a standalone OSS product whose users are developers buying tokens with a
card; a wallet flow and a second database are friction with no upside.

## Decision

1. **Providers:** OAuth **GitHub** and **Google**, plus **email magic link**. No SIWE, no passwords.
2. **One database.** Sessions, accounts and verification tokens live in the router's **PostgreSQL**
   (SQLite in dev). No auth-service, no MongoDB.
3. **Library:** [Better Auth](https://www.better-auth.com/) (already used in-house in swarm-cloud's
   `auth-service`) mounted inside `router-api` at `/auth/*` via a NestJS middleware; PostgreSQL adapter
   (Kysely/pg) in prod, SQLite adapter in dev; `magicLink` plugin with a pluggable mailer (`console` in dev,
   SMTP/Resend in prod via config). Its four tables (`user`, `session`, `account`, `verification`) are
   created by Better Auth migrations; TypeORM maps `user` read-only as the `User` entity and never
   synchronises those tables (`synchronize: false`, migrations own the schema).
   *Alternative considered:* hand-rolled `arctic` (OAuth) + own `Session` entity + nodemailer — fewer
   dependencies, ~1 500 more lines to own. Rejected for v1; the boundary (`AuthService` interface with
   `getSessionUser(req)`) lets us swap later.
4. **Session cookie:** `cr_session`, HttpOnly, Secure, `SameSite=Lax`, 30-day rolling expiry, stored
   server-side (session id → user). The GraphQL context resolves `viewer` from it. CSRF: state-changing
   GraphQL mutations require the `Origin` header to match `validClientOrigins` (same guard swarm-cloud
   uses for CORS).
5. **Workspaces:** every user gets a personal `Workspace` on first login (owner role). Workspace
   membership (`WorkspaceMember`, roles `owner | member`) exists in the data model from day one so team
   workspaces are an additive change; v1 UI exposes only the personal workspace.
6. **API keys are not sessions.** `/v1/*` authenticates with `Authorization: Bearer sk-tee-v1-…` only
   (ADR/contract `docs/contracts/router-api.md`); the console never accepts API keys, the gateway never
   accepts cookies.

## Consequences

- `router-api` config gains `auth.{baseUrl, secret, github{clientId,clientSecret}, google{…}, magicLink.mailer}`.
- e2e: Playwright signs in through the magic-link path with the `console` mailer (link printed to the API
  log / exposed on a test-only endpoint guarded by `NODE_ENV=test`).
- Deleting a user cascades to its personal workspace, keys and preferences; generations and ledger rows
  are retained anonymised (`userId` nulled) for accounting — see `docs/contracts/data-model.md`.
