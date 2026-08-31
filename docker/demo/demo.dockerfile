# syntax=docker/dockerfile:1
#
# The two stand-ins the demo stack needs and a real deployment does not: a
# LiteLLM-compatible backend and a `/.well-known/swarm-evidence` publisher.
# Both are single dependency-free scripts; one image runs either.
#
#   docker build -f docker/demo/demo.dockerfile -t cr-demo docker/demo
#   docker run --rm -p 4000:4000 cr-demo mock-litellm.mjs
#
# Named `demo.dockerfile` rather than `Dockerfile` so Nx's docker plugin, which
# infers a project from every `**/Dockerfile`, does not turn this directory into
# one. Never published to a registry and never part of a deployment — see
# docker/README.md.

FROM node:24-alpine

# `openssl` mints the demo PKI at startup: node:crypto signs, but it cannot
# issue a certificate.
RUN apk add --no-cache openssl

WORKDIR /srv
COPY mock-litellm.mjs evidence-publisher.mjs ./

# `node` already exists in this image with uid 1000.
USER node

ENTRYPOINT ["node"]
CMD ["mock-litellm.mjs"]
