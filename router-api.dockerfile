# syntax=docker/dockerfile:1
#
# router-api — the OpenAI-compatible gateway and the console's GraphQL API.
# Build from the repository root; the whole workspace is the build context.
#
#   docker build -f router-api.dockerfile -t router-api .
#   docker run --rm -p 3000:3000 router-api            # serve
#   docker run --rm router-api migrate                 # apply migrations, exit
#
# Two stages. The builder holds the workspace, the Nx graph and a C toolchain;
# the runner holds a webpack bundle, one compiled native module and nothing else
# — no pnpm, no compiler, no sources.

ARG NODE_IMAGE=node:24-alpine

# ---------------------------------------------------------------------------
# Builder
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS builder
WORKDIR /app

# node-gyp's toolchain. `better-sqlite3` publishes no musl prebuild, so it is
# compiled here — once, for this exact base image — and the runner inherits the
# result instead of a compiler.
RUN apk add --no-cache libc6-compat python3 make g++

RUN corepack enable

# `pnpm fetch` populates the store from the lockfile alone, so this layer is
# invalidated only by a dependency change — not by every source edit.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm fetch --frozen-lockfile

# The Nx graph needs every project, not just this one: router-api builds
# libs/server-common, and the inference plugins read the whole workspace.
COPY nx.json tsconfig.base.json tsconfig.json biome.json ./
COPY libs ./libs
COPY apps ./apps
RUN pnpm install --frozen-lockfile --offline

ENV NX_DAEMON=false \
    NX_CACHE_DIRECTORY=/tmp/nx-cache
RUN pnpm nx run @confidential-router/router-api:build

# Everything webpack left outside the bundle, at the versions this workspace
# resolved (apps/router-api/tools/runtime-deps.cjs). Installed with npm, not
# pnpm: the runner wants a plain flat `node_modules`, not a store full of
# symlinks pointing at paths that stage does not have.
RUN node apps/router-api/tools/runtime-deps.cjs /runtime/package.json \
 && cd /runtime \
 && npm install --omit=dev --no-audit --no-fund --loglevel=error

# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runner
WORKDIR /app

# The build identifier `/health` reports. `CR_API_VERSION` is a meta-variable,
# not configuration: the config loader skips it deliberately.
ARG CR_API_VERSION=0.0.0
ENV NODE_ENV=production \
    CR_API_VERSION=${CR_API_VERSION}

RUN apk add --no-cache libc6-compat \
 && addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 --ingroup nodejs router

COPY --from=builder /runtime/node_modules ./node_modules
COPY --from=builder /app/apps/router-api/dist ./
# Overwrites the manifest Nx generates next to the bundle, which lists every
# dependency webpack *inlined* and so describes a `node_modules` this image does
# not have. The runtime manifest is the one that matches what is installed.
COPY --from=builder /runtime/package.json ./package.json
COPY docker/router-api/entrypoint.sh /usr/local/bin/router-api

# `data/` is the SQLite default and the only path the process writes to; it is
# unused on PostgreSQL but has to exist and be writable when someone runs this
# image the zero-config way.
RUN rm -f /app/pnpm-lock.yaml \
 && chmod +x /usr/local/bin/router-api \
 && mkdir -p /app/data \
 && chown router:nodejs /app/data

USER router
EXPOSE 3000

# `/health` does a real database round-trip, so an unhealthy container is one
# that cannot serve — which is what `depends_on: service_healthy` should wait for.
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.CR_API_SERVER__PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/router-api"]
CMD ["serve"]
