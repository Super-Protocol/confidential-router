# syntax=docker/dockerfile:1
#
# The two stand-ins the demo stack needs and a real deployment does not: a
# LiteLLM-compatible backend and a `/.well-known/swarm-evidence` publisher.
# One image runs either.
#
#   docker build -f docker/demo/demo.dockerfile -t cr-demo .
#   docker run --rm -p 4000:4000 cr-demo mock-litellm/src/main.ts
#
# The build context is the repository root, because `mock-litellm` is not a copy
# kept next to the compose file — it is `tools/mock-litellm`, the same server the
# e2e suites import in process. Node runs its TypeScript sources directly (type
# stripping, on by default since Node 23.6), so the image still installs nothing.
#
# Named `demo.dockerfile` rather than `Dockerfile` so Nx's docker plugin, which
# infers a project from every `**/Dockerfile`, does not turn this directory into
# one. Never published to a registry and never part of a deployment — see
# docker/README.md.

FROM node:24-alpine

# `openssl` mints the evidence publisher's demo PKI at startup: node:crypto
# signs, but it cannot issue a certificate.
RUN apk add --no-cache openssl

WORKDIR /srv
COPY tools/mock-litellm/src ./mock-litellm/src
COPY docker/demo/evidence-publisher.mjs ./

# `node` already exists in this image with uid 1000.
USER node

ENTRYPOINT ["node"]
CMD ["mock-litellm/src/main.ts"]
