# syntax=docker/dockerfile:1
#
# gatekeeper — the attesting proxy, packaged for a cluster.
#
# The gatekeeper a *person* installs is a static binary from a GitHub Release
# (ADR-001, SUP-82) and this image changes nothing about that. It exists for the
# other caller: a pod that runs `gatekeeper run --headless` as an attested
# egress next to the process it serves, driven through its configuration file
# (ADR-008 §2, §5). The entrypoint is the supervisor that watches that file and
# reloads the gatekeeper in place; see apps/gatekeeper/pkg/sidecar.
#
# Build from the repository root; only apps/gatekeeper is in play.
#
#   docker build -f gatekeeper.dockerfile -t gatekeeper .
#   docker run --rm -v ./config.yaml:/etc/gatekeeper/config.yaml:ro \
#     -p 8443:8443 --read-only --user 65532 gatekeeper
#
# Anything one-shot runs the CLI directly, because the entrypoint supervises a
# long-lived process and waits for a configuration to be rendered first:
#
#   docker run --rm --entrypoint /usr/local/bin/gatekeeper gatekeeper version
#
# Both binaries are `CGO_ENABLED=0 -trimpath` builds, matching
# apps/gatekeeper/.goreleaser.yaml, so the image carries the same artefact the
# releases do.

ARG GO_IMAGE=golang:1.26-alpine
ARG RUNTIME_IMAGE=alpine:3.22

# ---------------------------------------------------------------------------
# Builder
# ---------------------------------------------------------------------------
FROM ${GO_IMAGE} AS builder
WORKDIR /src

# Dependencies first, so a source edit does not re-download the module graph.
COPY apps/gatekeeper/go.mod apps/gatekeeper/go.sum ./
RUN go mod download

COPY apps/gatekeeper/ ./

# The version metadata `gatekeeper version` and the dashboard report. Passed in
# by the release workflow; a local build says so.
ARG GATEKEEPER_VERSION=0.0.0-dev
ARG GATEKEEPER_COMMIT=unknown
ARG GATEKEEPER_DATE=unknown

ENV CGO_ENABLED=0 GOOS=linux
RUN go build -trimpath \
      -ldflags "-s -w \
        -X github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/version.version=${GATEKEEPER_VERSION} \
        -X github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/version.commit=${GATEKEEPER_COMMIT} \
        -X github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/version.date=${GATEKEEPER_DATE}" \
      -o /out/gatekeeper ./cmd/gatekeeper \
 && go build -trimpath -ldflags '-s -w' -o /out/gatekeeper-sidecar ./cmd/gatekeeper-sidecar

# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------
FROM ${RUNTIME_IMAGE} AS runner

# ca-certificates is not optional: the attested-root anchor fetches signed
# measurements and the firmware a measurement is rebuilt from over HTTPS, and
# an image without a CA bundle would fail that check — which is fail-closed, so
# it would refuse every endpoint rather than weaken one.
#
# 65532 is the conventional "nonroot" id, the same one distroless uses, so a
# chart can set `runAsUser: 65532` without reading this file.
RUN apk add --no-cache ca-certificates \
 && addgroup --system --gid 65532 nonroot \
 && adduser --system --uid 65532 --ingroup nonroot --no-create-home nonroot

COPY --from=builder /out/gatekeeper /usr/local/bin/gatekeeper
COPY --from=builder /out/gatekeeper-sidecar /usr/local/bin/gatekeeper-sidecar

# Where the configuration is expected to be mounted or rendered. Created here
# so that an empty volume mounted over it still belongs to the right user, and
# left out of VOLUME deliberately: the writer is another container in the pod.
RUN mkdir -p /etc/gatekeeper && chown nonroot:nonroot /etc/gatekeeper

# Nothing in the image is written to at run time — no state, no cache, no logs
# on disk — so this runs unchanged under `--read-only` /
# `readOnlyRootFilesystem: true`. An audit log, if one is configured, goes to a
# volume the operator mounts.
USER 65532:65532
ENV GATEKEEPER_CONFIG=/etc/gatekeeper/config.yaml

# No HEALTHCHECK: "is it serving?" is not a question this container can answer
# about itself without a verdict, and a probe that reported healthy while every
# endpoint was fail-closed would be worse than none. The admin API
# (`admin.listen`) is what a readiness probe reads, and it is loopback-only by
# construction — so the probe belongs to whoever shares the pod's network
# namespace, not here.
ENTRYPOINT ["/usr/local/bin/gatekeeper-sidecar"]
