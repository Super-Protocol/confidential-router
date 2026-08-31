# syntax=docker/dockerfile:1
#
# router-ui — the Confidential Router console (Next.js standalone output).
# Build from the repository root; the whole workspace is the build context.
#
#   docker build -f router-ui.dockerfile -t router-ui \
#     --build-arg NEXT_PUBLIC_API_ORIGIN=https://api.example.com \
#     --build-arg NEXT_PUBLIC_GRAPHQL_HTTP=https://api.example.com/graphql .
#
# The console's three `NEXT_PUBLIC_*` settings are inlined into the client bundle
# by `next build`, so **an image is bound to one API origin** (see
# apps/router-ui/README.md). Deploying on another origin means rebuilding with
# these build args, not setting environment variables on the container — a
# variable set at run time would be read by the server and ignored by the
# browser, which is worse than not offering it.

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

ARG NEXT_PUBLIC_API_ORIGIN=http://localhost:3000
ARG NEXT_PUBLIC_GRAPHQL_HTTP=http://localhost:3000/graphql
ARG NEXT_PUBLIC_AUTH_CALLBACK_URL=/
ENV NEXT_PUBLIC_API_ORIGIN=${NEXT_PUBLIC_API_ORIGIN} \
    NEXT_PUBLIC_GRAPHQL_HTTP=${NEXT_PUBLIC_GRAPHQL_HTTP} \
    NEXT_PUBLIC_AUTH_CALLBACK_URL=${NEXT_PUBLIC_AUTH_CALLBACK_URL} \
    NEXT_TELEMETRY_DISABLED=1 \
    NX_DAEMON=false \
    NX_CACHE_DIRECTORY=/tmp/nx-cache
RUN pnpm nx run @confidential-router/router-ui:build

# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
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
