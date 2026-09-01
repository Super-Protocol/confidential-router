# syntax=docker/dockerfile:1
#
# router-ui — the Confidential Router console (Next.js standalone output).
# Build from the repository root; the whole workspace is the build context.
#
#   docker build -f router-ui.dockerfile -t router-ui .
#
# The build takes no configuration: the console reads its public settings from
# the environment on every request and writes them into the document it serves
# (apps/router-ui/src/lib/public-config.ts), so **one image serves any API
# origin**. Point a container at one with `ROUTER_UI_API_ORIGIN`:
#
#   docker run -e ROUTER_UI_API_ORIGIN=https://api.example.com -p 3001:3001 router-ui
#
# That is what lets a marketplace listing pin this image by digest and still let
# the customer choose their own hostname at deploy time (SUP-100).

ARG NODE_IMAGE=node:24-alpine

# ---------------------------------------------------------------------------
# Builder
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS builder
WORKDIR /app

RUN apk add --no-cache libc6-compat
RUN corepack enable

# `pnpm fetch` populates the store from the lockfile alone, so this layer is
# invalidated only by a dependency change.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm fetch --frozen-lockfile

COPY nx.json tsconfig.base.json tsconfig.json biome.json ./
COPY libs ./libs
COPY apps ./apps
# `tools/` is part of the pnpm workspace and of the root tsconfig's project
# references, so leaving it out makes `--frozen-lockfile` and Nx's sync check
# both fail. Nothing from it reaches the runner stage.
COPY tools ./tools
RUN pnpm install --frozen-lockfile --offline

ENV NEXT_TELEMETRY_DISABLED=1 \
    NX_DAEMON=false \
    NX_CACHE_DIRECTORY=/tmp/nx-cache
RUN pnpm nx run @confidential-router/router-ui:build

# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runner
WORKDIR /app

# `ROUTER_UI_API_ORIGIN` is the one setting a deployment normally supplies;
# `ROUTER_UI_GRAPHQL_HTTP` and `ROUTER_UI_AUTH_CALLBACK_URL` default from it.
# The default here is the compose demo's API, so an unconfigured container is
# still the one the quickstart describes.
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    ROUTER_UI_API_ORIGIN=http://localhost:3000 \
    PORT=3001 \
    HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 --ingroup nodejs nextjs

# `output: 'standalone'` with `outputFileTracingRoot` at the workspace root emits
# a self-contained tree that keeps the monorepo layout: the server and its traced
# `node_modules` land under `apps/router-ui/`. Static assets are not traced and
# are copied separately, next to the server that serves them.
COPY --from=builder --chown=nextjs:nodejs /app/apps/router-ui/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/router-ui/.next/static ./apps/router-ui/.next/static

USER nextjs
EXPOSE 3001

# `/login` rather than `/`: it is the one route `src/proxy.ts` serves without a
# session cookie, so a healthy console answers it with a 200 and not a redirect.
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/router-ui/server.js"]
