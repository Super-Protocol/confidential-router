# docker

`docker-compose.dev.yml` brings up the backing services the router API needs
during local development. Today that is PostgreSQL 16 only; sessions live in
PostgreSQL (decision: no separate auth service, no MongoDB), so no other service
is required yet.

```bash
pnpm dev:up                     # start
pnpm dev:down                   # stop
docker compose -f docker/docker-compose.dev.yml logs -f postgres
```

Default connection string:

```
postgres://router:router@localhost:5432/router
```

Override any of `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`,
`POSTGRES_PORT` through `docker/.env` — that file is git-ignored.

The demo stack (router API + console + mock LiteLLM + evidence publisher) lands
with `SUP-83` / `SUP-84`.
