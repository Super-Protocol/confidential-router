# docker

Two compose files, for two different jobs.

| File | What it is | Command |
| --- | --- | --- |
| `docker-compose.dev.yml` | the backing services a locally-run `pnpm nx serve` needs — PostgreSQL only | `pnpm dev:up` / `pnpm dev:down` |
| `docker-compose.yml` | the whole product in containers: PostgreSQL, the migration job, `router-api`, the console — and, behind the `demo` profile, a mock model backend and a mock evidence publisher | `make up` / `make down` |

Both read `docker/.env` if it exists; start from [`.env.example`](./.env.example).
That file is git-ignored.

## The demo stack

```bash
cp docker/.env.example docker/.env          # optional; the defaults work
make up                                     # docker compose … --profile demo up --build
```

First run builds two images and takes a few minutes. Then:

| | |
| --- | --- |
| Console | <http://localhost:3001> |
| API | <http://localhost:3000> · [Swagger](http://localhost:3000/docs) · [GraphQL](http://localhost:3000/graphql) |
| Mock model backend | <http://localhost:4000> (`demo` profile) |
| Mock evidence publisher | <http://localhost:8081> (`demo` profile) |

Signing in takes no mail provider. Enter any address on the console, then open
the link the API prints:

```bash
docker compose -f docker/docker-compose.yml logs api | grep magic-link/verify
```

A new workspace starts at zero credits, so the first generation is refused with
`insufficient_credits` — which is the product working. Top up on the Credits
screen: with no Stripe keys configured the manual payment provider stands in and
completes the checkout without a card. Then mint a key on the API Keys screen and:

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-tee-v1-…" \
  -H 'content-type: application/json' \
  -d '{"model":"meta/llama-3.3-70b-instruct:tdx","messages":[{"role":"user","content":"hi"}]}'
```

`usage` comes back with `cost_micros`, `endpoint` and the `evidence_digest` that
endpoint had published when the request was served.

### Without the `demo` profile

`make up-core` brings up only PostgreSQL, the migration job, the API and the
console. Everything works except generating: `/v1` answers
`502 backend_unavailable` because no model backend is running, and the endpoints
read "Not published" because nothing is publishing evidence. Both are states a
real deployment has, and the console renders them.

## What the two demo services are

Neither is published to a registry, and neither belongs anywhere near a
deployment. They exist so a clone can show the whole pipeline working.

**`mock-litellm`** (`demo/mock-litellm.mjs`) answers the OpenAI-compatible calls
the router forwards — streaming included — for every model in the catalogue.
It counts a token as four characters, so the meter moves and the numbers look
sane; it is not a tokenizer.

**`evidence-publisher`** (`demo/evidence-publisher.mjs`) serves
`/<endpoint>/.well-known/swarm-evidence` for each endpoint hostname. The PKI is
real: an RSA root CA minted in the container at startup, one leaf per hostname,
and an RS256 JWS over a real `DeploymentEvidence` payload, re-signed every minute
so `issuedAt` stays fresh. **It attests nothing** — the root is generated here
and the TEE quote is a fabricated blob. It exists so the evidence pipeline has
something correctly shaped to carry.

Its root certificate is what you would add to a gatekeeper's `trustedRoots` to
verify this stack end to end:

```bash
curl -O http://localhost:8081/roots/demo-root.pem
```

## Read this before borrowing any of it

`docker-compose.yml` is a demo, and three of its choices are wrong for a
deployment:

- **`NODE_ENV=development`.** In production mode `router-api` requires a Resend
  API key for magic links and refuses to boot without Stripe credentials —
  correct for a deployment, and fatal for a stack meant to be usable two minutes
  after a clone.
- **Committed credentials.** The PostgreSQL password and `CR_API_AUTH__SECRET`
  are in the file. `CR_API_AUTH__SECRET` signs session cookies and magic-link
  tokens; generate your own with `openssl rand -hex 32`.
- **One host.** The console image is built against `http://localhost:3000`, and
  the API's CORS and Better Auth trusted origins name `http://localhost:3001`.

## Running the published images

The release workflow publishes `router-api` and `router-ui` to ghcr on every
push to `main` and every `router-v*` tag ([`.github/workflows/release-router.yml`](../.github/workflows/release-router.yml)).

```bash
ROUTER_API_IMAGE=ghcr.io/super-protocol/confidential-router/router-api:latest \
ROUTER_UI_IMAGE=ghcr.io/super-protocol/confidential-router/router-ui:latest \
  docker compose -f docker/docker-compose.yml pull

docker compose -f docker/docker-compose.yml up -d --no-build --wait
```

The published console image is built against `http://localhost:3000`:
`NEXT_PUBLIC_*` is inlined by `next build`, so a console image is bound to one
API origin. Deploying on another origin means building your own image with
`--build-arg NEXT_PUBLIC_API_ORIGIN=…` (or setting the `ROUTER_PUBLIC_API_ORIGIN`
repository variable, which the release workflow reads).

## Deploying `router-api`

```bash
docker run --rm \
  -e CR_API_DATABASE__TYPE=postgres \
  -e CR_API_DATABASE__URL=postgres://… \
  -e CR_API_AUTH__SECRET=… \
  ghcr.io/super-protocol/confidential-router/router-api:1.0.0 migrate
```

`migrate` applies Better Auth's four tables and this service's ten, then exits.
It is the *only* thing that applies the schema on PostgreSQL:
`database.migrationsRun` is off there so replicas do not race one another at
boot. Run it once, from a job or an init container, before the replicas roll; it
is idempotent, so a re-run on an up-to-date database is a no-op.

`docker run … router-api` with no argument serves. Anything else is executed
verbatim, so `docker run … router-api node -e '…'` still works.

The image is `NODE_ENV=production`, which is what makes `CR_API_AUTH__SECRET`
mandatory and turns off Swagger and GraphQL introspection. Configuration is a
YAML file plus `CR_API_*` variables — see
[`apps/router-api/README.md`](../apps/router-api/README.md). The image ships
`/app/conf/router.yaml` and `/app/conf/router.dev-seed.yaml`; a deployment
bind-mounts its own and points `CR_API_CONFIG_FILE` at it.

## Building the images by hand

```bash
make images                                     # both, tagged :local
docker build -f router-api.dockerfile -t router-api .
docker build -f router-ui.dockerfile -t router-ui \
  --build-arg NEXT_PUBLIC_API_ORIGIN=https://api.example.com \
  --build-arg NEXT_PUBLIC_GRAPHQL_HTTP=https://api.example.com/graphql .
```

The build context is the repository root for both — the Nx graph needs the whole
workspace — and both run as a non-root user with no compiler and no package
manager in the final stage.
